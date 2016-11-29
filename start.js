/*jslint node: true */
"use strict";
process.mainModule = module
var headlessWallet = require('headless-byteball');
var eventBus = require('byteballcore/event_bus.js');
var request = require('request');
var async = require('async');

function log2Everywhere(text){
    console.error(text);
	console.log(text);
}

function onError(err){
    log2Everywhere("DataFeed ERROR:"+err);
}

function onNotEnoughFunds(err){
    log2Everywhere("DataFeed WARN:"+err);
}

function createFloatNumberProcessor(decimalPointPrecision){
    var decimalPointMult = Math.pow(10, decimalPointPrecision);
    return function processValue(value){
        return Math.round(value * decimalPointMult)
    }
}

function initJob(){
    var walletGeneral = require('byteballcore/wallet_general.js');
    var composer = require('byteballcore/composer.js');
    var network = require('byteballcore/network.js');
    var db = require('byteballcore/db.js');
    
    var address;
    
    function runJob(){
        console.log("DataFeed: job started");
        var conn;
        async.series([
            function(cb){
                db.query(
                    "select * from outputs where address=? and is_spent=0", 
                    [address],
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
                    function(cb){ getBTCEData(datafeed, cb) }
                ], function(err){
                    if(err){
                        cb(err);
                        return;
                    }
                    var cbs = composer.getSavingCallbacks({
                        ifNotEnoughFunds: function(err){ 
                            onNotEnoughFunds(err);
                            cb();
                        },
                        ifError: cb,
                        ifOk: function(objJoint){
                            network.broadcastJoint(objJoint);
                            cb();
                        }
                    });
                    datafeed.timestamp = Date.now();
                    composer.composeDataFeedJoint(address, datafeed, headlessWallet.signer, cbs);
                });
            }
        ], function(err){
            if(err){
                onError(err);
                return;
            }
            console.log("DataFeed: published");
        });
    }
    
    walletGeneral.readMyAddresses(function(addresses){
        address = addresses[0];
        runJob();
        setInterval(runJob,300000);
    });
}

function getYahooData(datafeed, cb){
    
    var apiUri = 'https://query.yahooapis.com/v1/public/yql?q=select+*+from+yahoo.finance.xchange+where+pair+=+%22EURUSD,GBPUSD,USDJPY%22&format=json&env=store%3A%2F%2Fdatatables.org%2Falltableswithkeys&cb=';
    
    var processFloat = createFloatNumberProcessor(4);

    request(apiUri, function (error, response, body){
        if (!error && response.statusCode == 200) {
            var jsonResult = JSON.parse(body);
            datafeed.EURUSD = processFloat(jsonResult.query.results.rate[0].Rate);
            datafeed.GBPUSD = processFloat(jsonResult.query.results.rate[1].Rate);
            datafeed.USDJPY = processFloat(jsonResult.query.results.rate[2].Rate);
         }
        cb(error);
    });
}

function getBTCEData(datafeed, cb){
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
        cb(error);
    });
}

eventBus.on('headless_wallet_ready', initJob);
