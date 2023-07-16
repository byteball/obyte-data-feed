const { ethers } = require("ethers");
const { utils: { formatUnits } } = ethers;

const LINE = '0x31f8d38df6514b6cc3C360ACE3a2EFA7496214f6';

const pairAbi = [
	`function token0() public view returns (address)`,
	`function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)`,
];

const provider = new ethers.providers.JsonRpcProvider("https://evm.kava.io");
const pair = '0xFb1Efb5FD9dfb72f40B81bC5aa0e15d616BA8831'
const pair_contract = new ethers.Contract(pair, pairAbi, provider);

async function getLinePriceInGbyte() {
	const token0 = await pair_contract.token0();
	console.log(token0)
	const [reserve0, reserve1] = await pair_contract.getReserves();
	const r0 = formatUnits(reserve0)
	const r1 = formatUnits(reserve1)
	console.log({ r0, r1 })
	const price = LINE === token0 ? r1 / r0 : r0 / r1;
	console.log({price})
	return price;
}

exports.getLinePriceInGbyte = getLinePriceInGbyte;
