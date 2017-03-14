/*jslint node: true */
"use strict";
process.mainModule = module
var headlessWallet = require('headless-byteball');
var conf = require('byteballcore/conf.js');
var composer;
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var objectHash = require('byteballcore/object_hash.js');
var request = require('request');
var async = require('async');

var dataFeedAddress;
var maxDataFeedComission = 0;

headlessWallet.setupChatEventHandlers();

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
        return Math.round(value * decimalPointMult);
    }
}

function composeDataFeedAndPaymentJoint(from_address, payload, outputs, signer, callbacks){
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

function readNumberOfDataFeedingsAvailable(handleNumber){
	db.query(
		"SELECT COUNT(*) AS count_big_outputs FROM outputs JOIN units USING(unit) \n\
		WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0", 
		[dataFeedAddress, maxDataFeedComission], 
		function(rows){
			handleNumber(rows[0].count_big_outputs);
		}
	);
}

// make sure we never run out of spendable (stable) outputs. Keep the number above a threshold, and if it drops below, produce more outputs than consume.
function createOptimalOutputs(handleOutputs){
	var arrOutputs = [{amount: 0, address: dataFeedAddress}];
	readNumberOfDataFeedingsAvailable(function(count){
		if (count >= conf.minAvailableDataFeedings)
			return handleOutputs(arrOutputs);
		// try to split the biggest output in two
		db.query(
			"SELECT amount FROM outputs JOIN units USING(unit) \n\
			WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0 \n\
			ORDER BY amount DESC LIMIT 1", 
			[dataFeedAddress, 2*maxDataFeedComission],
			function(rows){
				if (rows.length === 0){
					log2Everywhere('DataFeed WARN:only '+count+" spendable outputs left, and can't add more");
					return handleOutputs(arrOutputs);
				}
				var amount = rows[0].amount;
				log2Everywhere('DataFeed WARN:only '+count+" spendable outputs left, will split an output of "+amount);
				arrOutputs.push({amount: Math.round(amount/2), address: dataFeedAddress});
				handleOutputs(arrOutputs);
			}
		);
	});
}

function initJob(){
    var network = require('byteballcore/network.js');
    composer = require('byteballcore/composer.js');
    
    if (conf.bSingleAddress)
        headlessWallet.readSingleAddress(initAddressAndRun);
    else
        initAddressAndRun(conf.dataFeedAddress);
        
    function initAddressAndRun(address){
        dataFeedAddress = address;
        console.log("DataFeed address:"+dataFeedAddress);
        runJob();
        setInterval(runJob,300000);
    }
        
    function runJob(){
        console.log("DataFeed: job started");
        async.series([
            function(cb){
                db.query(
                    "select * from outputs where address=? and is_spent=0", 
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
                            var feedComission = objJoint.unit.headers_commission + objJoint.unit.payload_commission; 
                            if(maxDataFeedComission < feedComission) maxDataFeedComission = feedComission;
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
            if(err){
                onError(err);
                return;
            }
            console.log("DataFeed: published");
        });
    }
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
