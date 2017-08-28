/*jslint node: true */
"use strict";
var headlessWallet = require('headless-byteball');
var conf = require('byteballcore/conf.js');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var objectHash = require('byteballcore/object_hash.js');
var desktopApp = require('byteballcore/desktop_app.js');
var request = require('request');
var async = require('async');
var notifications = require('./notifications.js');

const POSTING_PERIOD = 600*1000;

var dataFeedAddress;
var maxDataFeedComission = 700;
var count_postings_available = 0;
var prev_datafeed;

headlessWallet.setupChatEventHandlers();


function createFloatNumberProcessor(decimalPointPrecision){
	var decimalPointMult = Math.pow(10, decimalPointPrecision);
	return function processValue(value){
		return Math.round(value * decimalPointMult);
	}
}

function removeUnchanged(datafeed){
	var filtered_datafeed = {};
	if (prev_datafeed){
		for (var name in datafeed){
			if (datafeed[name] !== prev_datafeed[name])
				filtered_datafeed[name] = datafeed[name];
		}
	}
	else
		filtered_datafeed = datafeed;
	prev_datafeed = datafeed;
	return filtered_datafeed;
}

function composeDataFeedAndPaymentJoint(from_address, payload, outputs, signer, callbacks){
	var composer = require('byteballcore/composer.js');
	var objMessage = {
		app: "data_feed",
		payload_location: "inline",
		payload_hash: objectHash.getBase64Hash(payload),
		payload: payload
	};
	composer.composeJoint({
		paying_addresses: [from_address], 
		outputs: outputs, 
		messages: [objMessage], 
		signer: signer, 
		callbacks: callbacks
	});
}

function readNumberOfPostingsAvailable(handleNumber){
	count_postings_available--;
	if (count_postings_available > conf.MIN_AVAILABLE_POSTINGS)
		return handleNumber(count_postings_available);
	db.query(
		"SELECT COUNT(*) AS count_big_outputs FROM outputs JOIN units USING(unit) \n\
		WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0", 
		[dataFeedAddress, maxDataFeedComission], 
		function(rows){
			var count_big_outputs = rows[0].count_big_outputs;
			db.query(
				"SELECT SUM(amount) AS total FROM outputs JOIN units USING(unit) \n\
				WHERE address=? AND is_stable=1 AND amount<? AND asset IS NULL AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM witnessing_outputs \n\
				WHERE address=? AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM headers_commission_outputs \n\
				WHERE address=? AND is_spent=0", 
				[dataFeedAddress, maxDataFeedComission, dataFeedAddress, dataFeedAddress], 
				function(rows){
					var total = rows.reduce(function(prev, row){ return (prev + row.total); }, 0);
					var count_postings_paid_by_small_outputs_and_commissions = Math.round(total / maxDataFeedComission);
					count_postings_available = count_big_outputs + count_postings_paid_by_small_outputs_and_commissions;
					handleNumber(count_postings_available);
				}
			);
		}
	);
}


// make sure we never run out of spendable (stable) outputs. Keep the number above a threshold, and if it drops below, produce more outputs than consume.
function createOptimalOutputs(handleOutputs){
	var arrOutputs = [{amount: 0, address: dataFeedAddress}];
	readNumberOfPostingsAvailable(function(count){
		if (count >= conf.MIN_AVAILABLE_POSTINGS)
			return handleOutputs(arrOutputs);
		// try to split the biggest output in two
		db.query(
			"SELECT amount FROM outputs JOIN units USING(unit) \n\
			WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0 \n\
			ORDER BY amount DESC LIMIT 1", 
			[dataFeedAddress, 2*maxDataFeedComission],
			function(rows){
				if (rows.length === 0){
					notifications.notifyAdminAboutPostingProblem('DataFeed WARN:only '+count+" spendable outputs left, and can't add more");
					return handleOutputs(arrOutputs);
				}
				var amount = rows[0].amount;
			//	notifications.notifyAdminAboutPostingProblem('DataFeed WARN:only '+count+" spendable outputs left, will split an output of "+amount);
				arrOutputs.push({amount: Math.round(amount/2), address: dataFeedAddress});
				handleOutputs(arrOutputs);
			}
		);
	});
}

function initJob(){
	var network = require('byteballcore/network.js');
	var composer = require('byteballcore/composer.js');
	
	if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
	
	if (conf.bSingleAddress)
		headlessWallet.readSingleAddress(initAddressAndRun);
	else
		initAddressAndRun(conf.dataFeedAddress);
		
	function initAddressAndRun(address){
		dataFeedAddress = address;
		console.log("DataFeed address: "+dataFeedAddress);
		runJob();
		setInterval(runJob, POSTING_PERIOD);
	}
		
	function runJob(){
		console.log("DataFeed: job started");
		async.series([
			function(cb){
				db.query(
					"SELECT 1 FROM outputs WHERE address=? AND is_spent=0 AND asset IS NULL LIMIT 1", 
					[dataFeedAddress],
					function(rows){
						if (rows.length > 0)
							return cb();
						cb("No spendable outputs");
					}
				);
			},
			function(cb){
				var datafeed={};
				async.parallel([
					function(cb){ getYahooData(datafeed, cb) },
					function(cb){ getCryptoCoinData(datafeed, cb) }
				//	function(cb){ getCoinMarketCapData(datafeed, cb) }
				], function(){
					if (Object.keys(datafeed).length === 0) // all data sources failed, nothing to post
						return cb();
					datafeed = removeUnchanged(datafeed);
					if (Object.keys(datafeed).length === 0) // no changes, nothing to post
						return cb();
					var cbs = composer.getSavingCallbacks({
						ifNotEnoughFunds: function(err){ 
							notifications.notifyAdminAboutPostingProblem(err);
							cb();
						},
						ifError: cb,
						ifOk: function(objJoint){
							var feedComission = objJoint.unit.headers_commission + objJoint.unit.payload_commission; 
							if(maxDataFeedComission < feedComission)
								maxDataFeedComission = feedComission;
							// console.log("DataFeed:"+JSON.stringify(objJoint));
							network.broadcastJoint(objJoint);
							cb();
						}
					});
					datafeed.timestamp = Date.now();
					createOptimalOutputs(function(arrOutputs){
						composeDataFeedAndPaymentJoint(dataFeedAddress, datafeed, arrOutputs, headlessWallet.signer, cbs)
					});
				});
			}
		], function(err){
			if (err)
				return notifications.notifyAdminAboutPostingProblem(err);
			console.log("DataFeed: published");
		});
	}
}

function getYahooData(datafeed, cb){
	var apiUri = 'https://query.yahooapis.com/v1/public/yql?q=select+*+from+yahoo.finance.xchange+where+pair+=+%22EURUSD,GBPUSD,USDJPY%22&format=json&env=store%3A%2F%2Fdatatables.org%2Falltableswithkeys&cb=';
//	var processFloat = createFloatNumberProcessor(4);
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			var jsonResult = JSON.parse(body);
			if (jsonResult.query && jsonResult.query.results && jsonResult.query.results.rate){
				datafeed.EUR_USD = jsonResult.query.results.rate[0].Rate;
				datafeed.GBP_USD = jsonResult.query.results.rate[1].Rate;
				datafeed.USD_JPY = jsonResult.query.results.rate[2].Rate;
			}
			else
				notifications.notifyAdminAboutPostingProblem("bad response from yahoo: "+body);
		}
		else
			notifications.notifyAdminAboutPostingProblem("getting yahoo data failed: "+error+", status="+(response ? response.statusCode : '?'));
		cb();
	});
}


function getCoinMarketCapData(datafeed, cb){
	var apiUri = 'https://api.coinmarketcap.com/v1/ticker/?limit=100';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			let arrCoins = JSON.parse(body);
			arrCoins.forEach(coin => {
				datafeed[coin.symbol+'_USD'] = coin.price_usd;
				if (coin.symbol !== 'BTC')
					datafeed[coin.symbol+'_BTC'] = coin.price_btc;
			});
		}
		else
			notifications.notifyAdminAboutPostingProblem("getting coinmarketcap data failed: "+error+", status="+(response ? response.statusCode : '?'));
		cb();
	});
}

function getPriceInUsd(price, strBtcPrice){
	var price_in_usd = (price * strBtcPrice).toFixed(8);
	let arr = price_in_usd.split('.');
	let int = arr[0];
	let frac = arr[1];
	if (int > 0 || frac[0] !== '0')
		price_in_usd = parseFloat(price_in_usd).toFixed(6-int.length);
	else if (frac[1] !== '0')
		price_in_usd = parseFloat(price_in_usd).toFixed(6);
	else if (frac[2] !== '0')
		price_in_usd = parseFloat(price_in_usd).toFixed(7);
	return price_in_usd;
}

function mergeAssoc(dest, src){
	for (var key in src)
		if (!dest[key])
			dest[key] = src[key];
}

function getCryptoCoinData(datafeed, cb){
	getBitfinexBtcPrice(function(err, strBtcPrice){
		if (err)
			return cb();
		datafeed['BTC_USD'] = strBtcPrice;
		getPoloniexData(strBtcPrice, function(err, poloData){
			if (err)
				return cb();
			mergeAssoc(datafeed, poloData);
			getBittrexData(strBtcPrice, function(err, bittrexData){
				if (err)
					return cb();
				mergeAssoc(datafeed, bittrexData);
				cb();
			});
		});
	});
}

function getBitfinexBtcPrice(cb){
	function onError(err){
		notifications.notifyAdminAboutPostingProblem(err);
		cb(err);
	}
	var apiUri = 'https://api.bitfinex.com/v1/pubticker/btcusd';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			let info = JSON.parse(body);
			let strBtcPrice = info.last_price;
			if (!strBtcPrice)
				return onError("invalid bitfinex response: "+body);
			cb(null, strBtcPrice);
		}
		else
			onError("getting bitfinex data failed: "+error+", status="+(response ? response.statusCode : '?'));
	});
}

function getPoloniexData(strBtcPrice, cb){
	function onError(err){
		notifications.notifyAdminAboutPostingProblem(err);
		cb(err);
	}
	var datafeed = {};
	const apiUri = 'https://poloniex.com/public?command=returnTicker';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			let assocPairs = JSON.parse(body);
			for (var pair in assocPairs){
				let price = assocPairs[pair].last; // string
				if (!price)
					return onError("bad polo price of "+pair);
				let arrParts = pair.split('_');
				let market = arrParts[0];
				let coin = arrParts[1];
				if (market !== 'BTC')
					continue;
				datafeed[coin+'_BTC'] = price;
				datafeed[coin+'_USD'] = getPriceInUsd(price, strBtcPrice);
			}
			cb(null, datafeed);
		}
		else
			onError("getting poloniex data failed: "+error+", status="+(response ? response.statusCode : '?'));
	});
}

function getBittrexData(strBtcPrice, cb){
	function onError(err){
		notifications.notifyAdminAboutPostingProblem(err);
		cb(err);
	}
	var datafeed = {};
	const apiUri = 'https://bittrex.com/api/v1.1/public/getmarketsummaries';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			let arrCoinInfos = JSON.parse(body).result;
			arrCoinInfos.forEach(coinInfo => {
				let price = coinInfo.Last; // number
				if (!price)
					return;
				let arrParts = coinInfo.MarketName.split('-');
				let market = arrParts[0];
				let coin = arrParts[1];
				if (market !== 'BTC')
					return;
				datafeed[coin+'_BTC'] = price.toFixed(8);
				datafeed[coin+'_USD'] = getPriceInUsd(price, strBtcPrice);
			});
			cb(null, datafeed);
		}
		else
			onError("getting bittrex data failed: "+error+", status="+(response ? response.statusCode : '?'));
	});
}



//getCryptoCoinData({}, function(){});

eventBus.on('headless_wallet_ready', initJob);
