/*jslint node: true */
'use strict';

function formatPriceToPrecision(fPrice, accuracy = 6) {
	if (!accuracy || accuracy < 1)
		throw Error("1 for accuracy is min");
	if (accuracy > 16)
		throw Error("16 for accuracy is max");
	let price_in_usd = fPrice.toFixed(18);
	let arr = price_in_usd.split('.');
	let int = arr[0];
	let frac = arr[1].replace(Number(arr[1]).toFixed(0), '');
	if (int.length > accuracy)
		price_in_usd = parseFloat(price_in_usd).toFixed(0);
	else if (int > 0)
		price_in_usd = parseFloat(price_in_usd).toFixed(accuracy-int.length);
	else if (frac[0] !== '0')
		price_in_usd = parseFloat(price_in_usd).toFixed(accuracy);
	else if (frac[1] !== '0')
		price_in_usd = parseFloat(price_in_usd).toFixed(accuracy+1);
	else 
		price_in_usd = parseFloat(price_in_usd).toFixed(accuracy+frac.length);
	return price_in_usd;
}

exports.formatPriceToPrecision = formatPriceToPrecision;