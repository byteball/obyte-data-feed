/*jslint node: true */
"use strict";
process.mainModule = module
var headlessWallet = require('headless-byteball');
var eventBus = require('byteballcore/event_bus.js');
var request = require('request');
var async = require('async');

function onError(err){
	console.log("Error: "+err);
}

function createFloatNumberProcessor(decimalPointPrecision){
    var decimalPointMult = Math.pow(10, decimalPointPrecision);
    return function processValue(value){
        return Math.round(value * decimalPointMult)
    }
}

function initJob(){
    var composer = require('byteballcore/composer.js');
    var network = require('byteballcore/network.js');
    
    function runJob(){
        var datafeed={};
        async.parallel([
            function(callback) { getYahooData(datafeed, callback) },
            function(callback) { getBTCEData(datafeed, callback) }
        ], function(err, results) {
            var callbacks = composer.getSavingCallbacks({
                ifNotEnoughFunds: onError,
                ifError: onError,
                ifOk: function(objJoint){
                    network.broadcastJoint(objJoint);
                }
            });
            datafeed.timestamp = Date.now();
            composer.composeDataFeedJoint("7ZA3YD3CCHCBDEQA5PEVHT6L45WKLXKJ", datafeed, headlessWallet.signer, callbacks);
        });
    }
    
    runJob();
    setInterval(runJob,300000);
}

function getYahooData(datafeed, callback){
    
    var apiUri = 'https://query.yahooapis.com/v1/public/yql?q=select+*+from+yahoo.finance.xchange+where+pair+=+%22EURUSD,GBPUSD,USDJPY%22&format=json&env=store%3A%2F%2Fdatatables.org%2Falltableswithkeys&callback=';
    
    var processFloat = createFloatNumberProcessor(4);

    request(apiUri, function (error, response, body){
            if (!error && response.statusCode == 200) {
                var jsonResult = JSON.parse(body);
                datafeed.EURUSD = processFloat(jsonResult.query.results.rate[0].Rate);
                datafeed.GBPUSD = processFloat(jsonResult.query.results.rate[1].Rate);
                datafeed.USDJPY = processFloat(jsonResult.query.results.rate[2].Rate);
             }
            callback(error);
        });
}

function getBTCEData(datafeed, callback){
    var apiUri = 'https://btc-e.com/api/3/ticker/btc_usd-eth_btc-eth_usd';
    
    var processFloat = createFloatNumberProcessor(6);
    
    request(apiUri, function (error, response, body){
            if (!error && response.statusCode == 200) {
                var jsonResult = JSON.parse(body);
                datafeed.BTCUSD = processFloat(jsonResult.btc_usd.last);
                datafeed.BTCUSD_AVG = processFloat(jsonResult.btc_usd.avg);
                datafeed.ETHBTC = processFloat(jsonResult.eth_btc.last);
                datafeed.ETHBTC_AVG = processFloat(jsonResult.eth_btc.avg);
                datafeed.ETHUSD = processFloat(jsonResult.eth_usd.last);
                datafeed.ETHUSD_AVG = processFloat(jsonResult.eth_usd.avg);
             }
            callback(error);
        });
}

eventBus.on('headless_wallet_ready', initJob);
