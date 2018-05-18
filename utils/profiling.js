const async = require('async');

class ProfilingContext {
	constructor () {
		this.timestamps = [];
		this.timerCollection = [];
		this.functions = [];
		this.initialTimestamp = null;
	}

	initial () {
		this.initialTimestamp = Math.floor(parseInt(process.hrtime().join('')) / 1000);
	}

	addMark (name) {
		let timestamp = Math.floor(parseInt(process.hrtime().join('')) / 1000);

		if (!this.timestamps.length) {
			this.timerCollection.push(timestamp - this.initialTimestamp);
		} else {
			this.timerCollection.push(timestamp - this.timestamps[this.timestamps.length - 1]);
		}
		this.timestamps.push(timestamp);
		this.functions.push(name);
	}

	show () {
		async.reduce(this.timerCollection, 0, (memo, item, c) => {
			c(null, memo + item);
		}, (err, totalTime) => { // eslint-disable-line handle-callback-err
			console.log(`Total time: ${totalTime} μs`);

			this.functions.forEach((item, index) => {
				console.log(`[${item}]: ${this.timerCollection[index]} μs (${(this.timerCollection[index] / totalTime * 100).toPrecision(3)}%)`);
			});
		});
	}
}

module.exports = ProfilingContext;
