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
const db = require('ocore/db.js');
const { executeGetter } = require('ocore/formula/evaluation.js');
var request = require('request');
var async = require('async');
var notifications = require('./modules/notifications.js');
var price = require('./modules/price.js');
const kava = require('./modules/kava.js');

const POSTING_PERIOD = 600*1000;

var dataFeedAddress;
var prev_datafeed;
var prevDatafeeds = [];

headlessWallet.setupChatEventHandlers();


function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

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
	data_feeds.readDataFeedValue([address], feed_name, null, 0, max_mci, false, 'last', 0, objResult => {
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
	
	const network = require('ocore/network.js');
	await wait(10 * 1000);
	await network.waitUntilCatchedUp();
	console.log('catched up');
	
	await initPrevDatafeeds();

	runJob();
//	setInterval(runJob, POSTING_PERIOD);
	
	function getRandomTimeout(min, max) {
		return Math.round(min * 60 * 1000 + (max - min) * 60 * 1000 * Math.random());
	}

	function scheduleNextPosting() {
		setTimeout(runJob, getRandomTimeout(5, 35));
	}
		
	function runJob(){
		console.log("DataFeed: job started");
		var datafeed={};
		async.parallel([
		//	function(cb){ getYahooDataWithRetries(datafeed, cb) }, // shut down in nov 2017
			function(cb){ getCryptoCoinData(datafeed, cb) },
			function(cb){ getCoinMarketCapGlobalData(datafeed, cb) }
		//	function(cb){ getCoinMarketCapData(datafeed, cb) }
		], function(){
			scheduleNextPosting();
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
//	var apiUri = 'https://api.coinmarketcap.com/v1/global/';
	console.log('getting CMC global data');
	const requestOptions = {
		method: 'GET',
		uri: 'https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest',
		qs: {
			'convert': 'USD'
		},
		headers: {
			'X-CMC_PRO_API_KEY': conf.CMC_API_KEY
		},
		json: true,
		gzip: true
	};
	request(requestOptions, function (error, response, body) {
		try {
			if (!error && response.statusCode == 200) {
				datafeed['TOTAL_CAP'] = (body.data.quote.USD.total_market_cap / 1e9).toFixed(3);
				datafeed['BTC_PERCENTAGE'] = body.data.btc_dominance.toString();
				datafeed['ETH_PERCENTAGE'] = body.data.eth_dominance.toString();
			}
			else
				notifications.notifyAdminAboutPostingProblem("getting coinmarketcap global data failed: " + error + ", status=" + (response ? response.statusCode : '?'));
		}
		catch (e) {
			notifications.notifyAdminAboutPostingProblem("parsing CMC data failed: " + e + ", body: " + JSON.stringify(body, null, '\t'));
		}
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

function getPriceInUsd(p, strBtcPrice){
	return price.formatPriceToPrecision(p * strBtcPrice);
}

function mergeAssoc(dest, src){
	for (var key in src)
		if (!dest[key])
			dest[key] = src[key];
}

function getCryptoCoinData(datafeed, cb){
	getBitfinexBtcPrice(async function(err, strBtcPrice){
		if (err)
			return cb();
		datafeed['BTC_USD'] = strBtcPrice;
	//	getPoloniexData(strBtcPrice, function(err, poloData){
	//		if (err)
	//			return cb();
	//		mergeAssoc(datafeed, poloData);
		const gbyteData = await getGbyteData(strBtcPrice);
		mergeAssoc(datafeed, gbyteData);
		getBinanceData(strBtcPrice, async function(err, binanceData){
			if (err)
				return cb();
			mergeAssoc(datafeed, binanceData);
			await addKavaData(datafeed);
			cb();
		});
	//	});
	});
}

function getBitfinexBtcPrice(cb){
	function onError(err){
		notifications.notifyAdminAboutPostingProblem(err);
		cb(err);
	}
	console.log('getting bitfinex data');
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
	console.log('getting polo data');
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
	console.log('getting bittrex data');
	var datafeed = {};
	const apiUri = 'https://api.bittrex.com/v3/markets/tickers';
//	const apiUri = 'https://bittrex.com/api/v1.1/public/getmarketsummaries';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			try{
				var arrCoinInfos = JSON.parse(body);
			}
			catch(e){
				return onError(e.toString());
			}
			if (!arrCoinInfos)
				return onError('bad rates from bittrex');
			arrCoinInfos.forEach(coinInfo => {
				let price = coinInfo.lastTradeRate; // number
				if (!price)
					return;
				let [coin, market] = coinInfo.symbol.split('-');
				if (market !== 'BTC')
					return;
				datafeed[coin+'_BTC'] = (+price).toFixed(8);
				datafeed[coin+'_USD'] = getPriceInUsd(price, strBtcPrice);
			});
			cb(null, datafeed);
		}
		else
			onError("getting bittrex data failed: "+error+", status="+(response ? response.statusCode : '?'));
	});
}

async function getGbyteData(strBtcPrice) {
	console.log('getting GBYTE data');
	let datafeed = {};
	datafeed['GBYTE_USD'] = await executeGetter(db,  process.env.testnet ? 'CFJTSWILG4FJGJJAN7II7FHP2TAFBB57' : 'MBTF5GG44S3ARJHIZH3DEAB4DGUCHCF6', 'get_price', ['x', 9, 4]);
	datafeed['GBYTE_BTC'] = datafeed['GBYTE_USD'] / strBtcPrice;
	return datafeed;
}

function getBinanceData(strBtcPrice, cb){
	function onError(err){
		notifications.notifyAdminAboutPostingProblem(err);
		cb(err);
	}
	console.log('getting binance data');
	var datafeed = {};
	const apiUri = 'https://api.binance.com/api/v3/ticker/price';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			try{
				var prices = JSON.parse(body);
			}
			catch(e){
				return onError(e.toString());
			}
			if (!prices)
				return onError('bad rates from binance');
			for (let priceInfo of prices) {
				if (priceInfo.symbol === 'BNBBTC')
					datafeed['BNB_BTC'] = priceInfo.price;
				if (priceInfo.symbol === 'BNBUSDT')
					datafeed['BNB_USD'] = priceInfo.price;
				if (priceInfo.symbol === 'KAVABTC')
					datafeed['KAVA_BTC'] = priceInfo.price;
				if (priceInfo.symbol === 'KAVAUSDT')
					datafeed['KAVA_USD'] = priceInfo.price;
			}
			cb(null, datafeed);
		}
		else
			onError("getting binance data failed: "+error+", status="+(response ? response.statusCode : '?'));
	});
}

async function addKavaData(datafeed) {
	try {
		const p = await kava.getLinePriceInGbyte();
		datafeed['LINE_GBYTE'] = price.formatPriceToPrecision(p);
	}
	catch (e) {
		console.log(`fetching prices on Kava failed`, e);
	}
}



//getCryptoCoinData({}, function(){});

eventBus.on('headless_wallet_ready', initJob);
