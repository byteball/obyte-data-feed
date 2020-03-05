/*jslint node: true */
'use strict';

function formatPriceToPrecision(fPrice) {
	let price_in_usd = fPrice.toFixed(18);
	let arr = price_in_usd.split('.');
	let int = arr[0];
	let frac = arr[1].replace(Number(arr[1]).toFixed(0), '');
	if (int.length > 6)
		price_in_usd = parseFloat(price_in_usd).toFixed(0);
	else if (int > 0)
		price_in_usd = parseFloat(price_in_usd).toFixed(6-int.length);
	else if (frac[0] !== '0')
		price_in_usd = parseFloat(price_in_usd).toFixed(6);
	else if (frac[1] !== '0')
		price_in_usd = parseFloat(price_in_usd).toFixed(7);
	else 
		price_in_usd = parseFloat(price_in_usd).toFixed(6+frac.length);
	return price_in_usd;
}

exports.formatPriceToPrecision = formatPriceToPrecision;