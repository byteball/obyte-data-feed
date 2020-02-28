/*jslint node: true */
"use strict";

//exports.port = 6611;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;


exports.storage = 'sqlite';


exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'Price Oracle';
exports.permanent_pairing_secret = 'randomstring';
exports.control_addresses = ['DEVICE ALLOWED TO CHAT'];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';
//Wallet uses first address if bSingleAddress == true or you have to tell it what address to use with dataFeedAddress parameter
exports.bSingleAddress = true;
exports.dataFeedAddress = "";
exports.bWantNewPeers = false;

exports.KEYS_FILENAME = 'keys.json';

console.log('finished price oracle conf');
