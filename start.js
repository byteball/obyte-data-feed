/*jslint node: true */
"use strict";
var fs = require('fs');
var desktopApp = require('ocore/desktop_app.js');
var appDataDir = desktopApp.getAppDataDir();
var path = require('path');

if (require.main === module && !fs.existsSync(appDataDir) && fs.existsSync(path.dirname(appDataDir)+'/byteball-data-feed')){
	console.log('=== will rename old data-feed data dir');
	fs.renameSync(path.dirname(appDataDir)+'/byteball-data-feed', appDataDir);
}
var headlessWallet = require('headless-obyte');
var conf = require('ocore/conf.js');
var eventBus = require('ocore/event_bus.js');
var objectHash = require('ocore/object_hash.js');
var request = require('request');
var async = require('async');
var notifications = require('./modules/notifications.js');
var price = require('./modules/price.js');

const POSTING_PERIOD = 600*1000;

var dataFeedAddress;
var prev_datafeed;
var prevDatafeeds = [];

headlessWallet.setupChatEventHandlers();


function createFloatNumberProcessor(decimalPointPrecision){
	var decimalPointMult = Math.pow(10, decimalPointPrecision);
	return function processValue(value){
		return Math.round(value * decimalPointMult);
	}
}

function getAverage(name) {
	return prevDatafeeds.reduce((acc, df) => acc + parseFloat(df[name]), 0) / prevDatafeeds.length;
}

function getFormattedAverage(name) {
	let avg = getAverage(name);
	if (name.endsWith('_BTC'))
		return avg.toFixed(8);
	if (name.endsWith('_GBYTE'))
		return avg.toFixed(9);
	return price.formatPriceToPrecision(avg);
}

function addMAs(datafeed) {
	if (!conf.maPairs || !conf.ma_length)
		return console.log("skipping MA because maPairs is not defined");
	var filtered_datafeed = {};
	for (const name of conf.maPairs) {
		if (!datafeed[name])
			return console.log("skipping MA because there is no data feed for " + name);
		filtered_datafeed[name] = datafeed[name];
	}
	prevDatafeeds.push(filtered_datafeed);
	if (prevDatafeeds.length > conf.ma_length)
		prevDatafeeds.shift(); // forget old data
	conf.maPairs.forEach(name => {
		if (prevDatafeeds[0][name]) // only if we have the entire row of 10 values
			datafeed[name + '_MA'] = getFormattedAverage(name);
	});
}

function readLastDataFeedValue(address, feed_name, max_mci, handleResult) {
	if (!handleResult)
		return new Promise(resolve => readLastDataFeedValue(address, feed_name, max_mci, resolve));
	const data_feeds = require('ocore/data_feeds.js');
	data_feeds.readDataFeedValue([address], feed_name, null, 0, max_mci, false, 'last', objResult => {
		handleResult({ value: objResult.value, mci: objResult.mci });
	});
}

async function getLastDataFeedValues(address, feed_name) {
	let values = [];
	let max_mci = 1e15;
	for (let i = 0; i < conf.ma_length; i++){
		let { value, mci } = await readLastDataFeedValue(address, feed_name, max_mci);
		if (!value)
			break;
		if (!mci)
			throw Error("have value " + value + " but not mci");
		values.push(value);
		max_mci = mci - 1;
	}
	return values;
}

async function initPrevDatafeeds() {
	if (!conf.ma_length || !conf.maPairs || conf.maPairs.length === 0)
		return;
	let valuesByFeedname = {};
	for (const name of conf.maPairs)
		valuesByFeedname[name] = await getLastDataFeedValues(dataFeedAddress, name);
	for (let i = 0; i < conf.ma_length; i++){
		let df = {};
		for (const name of conf.maPairs)
			if (valuesByFeedname[name][i])
				df[name] = valuesByFeedname[name][i];
		if (Object.keys(df).length === 0)
			break;
		prevDatafeeds.push(df);
	}
	prevDatafeeds.reverse();
	console.log('prev data feeds', prevDatafeeds);
}

function removeUnchanged(datafeed){
	var filtered_datafeed = {};
	if (prev_datafeed){
		for (var name in datafeed){
			if (conf.maPairs.includes(name) || datafeed[name] !== prev_datafeed[name])
				filtered_datafeed[name] = datafeed[name];
		}
	}
	else
		filtered_datafeed = datafeed;
	prev_datafeed = datafeed;
	return filtered_datafeed;
}

async function initJob(){
	if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
	
	if (conf.bSingleAddress)
		dataFeedAddress = await headlessWallet.readSingleAddress();
	else
		dataFeedAddress = conf.dataFeedAddress;
	console.log("DataFeed address: " + dataFeedAddress);
	
	await initPrevDatafeeds();

	runJob();
	setInterval(runJob, POSTING_PERIOD);
		
	function runJob(){
		console.log("DataFeed: job started");
		var datafeed={};
		async.parallel([
		//	function(cb){ getYahooDataWithRetries(datafeed, cb) }, // shut down in nov 2017
			function(cb){ getCryptoCoinData(datafeed, cb) },
			function(cb){ getCoinMarketCapGlobalData(datafeed, cb) }
		//	function(cb){ getCoinMarketCapData(datafeed, cb) }
		], function(){
			if (Object.keys(datafeed).length === 0) // all data sources failed, nothing to post
				return console.log('nothing to post');
			datafeed = removeUnchanged(datafeed);
			addMAs(datafeed);
			if (Object.keys(datafeed).length === 0) // no changes, nothing to post
				return console.log('no changes');
			datafeed.timestamp = Date.now();
			datafeed.hash = objectHash.getBase64Hash(datafeed); // this can serve as randomness seed
			var objMessage = {
				app: "data_feed",
				payload_location: "inline",
				payload_hash: objectHash.getBase64Hash(datafeed),
				payload: datafeed
			};
			var opts = {
				paying_addresses: [dataFeedAddress],
				change_address: dataFeedAddress,
				messages: [objMessage]
			};
			headlessWallet.sendMultiPayment(opts, function(err, unit){
				if (err)
					return notifications.notifyAdminAboutPostingProblem(err);
				console.log("DataFeed published: " + unit);
			});
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
				cb();
			}
			else
				cb("bad response from yahoo: "+body);
		}
		else
			cb("getting yahoo data failed: "+error+", status="+(response ? response.statusCode : '?'));
	});
}

function getYahooDataWithRetries(datafeed, cb){
	let count_tries = 0;
	function tryToGetData(){
		getYahooData(datafeed, function(err){
			count_tries++;
			if (err && count_tries < 10)
				return tryToGetData();
			if (err)
				notifications.notifyAdminAboutPostingProblem(err);
			cb();
		});
	}
	tryToGetData();
}

function getCoinMarketCapGlobalData(datafeed, cb){
	var apiUri = 'https://api.coinmarketcap.com/v1/global/';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			let global_data = JSON.parse(body);
			datafeed['TOTAL_CAP'] = (global_data.total_market_cap_usd/1e9).toFixed(3);
			datafeed['BTC_PERCENTAGE'] = global_data.bitcoin_percentage_of_market_cap.toString();
		}
		else
			notifications.notifyAdminAboutPostingProblem("getting coinmarketcap global data failed: "+error+", status="+(response ? response.statusCode : '?'));
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
	return price.formatPriceToPrecision(price * strBtcPrice);
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
			console.log("bitfinex response: "+body);
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
			try{
				var assocPairs = JSON.parse(body);
			}
			catch(e){
				return onError(e.toString());
			}
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
			try{
				var arrCoinInfos = JSON.parse(body).result;
			}
			catch(e){
				return onError(e.toString());
			}
			if (!arrCoinInfos)
				return onError('bad rates from bittrex');
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
