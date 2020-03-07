/*jslint node: true */
'use strict';

function formatPriceToPrecision(fPrice, accuracy = 6) {
	if (!accuracy || accuracy < 1)
		throw Error("1 for accuracy is min");
	if (accuracy > 16)
		throw Error("16 for accuracy is max");
	let price_result = fPrice.toFixed(18);
	let arr = price_result.split('.');
	let int = arr[0];
	let leading_zeros = arr[1].match(/^0*/)[0];
	if (int.length >= accuracy)
		price_result = int;
	else if (fPrice >= 0.01 || leading_zeros.length < accuracy)
		price_result = parseFloat(price_result).toPrecision(accuracy);
	else
		price_result = parseFloat(price_result).toFixed(accuracy+leading_zeros.length);
	return price_result.replace(/(\.[0-9]*[1-9])0+$|\.0*$/,'$1');
}

exports.formatPriceToPrecision = formatPriceToPrecision;