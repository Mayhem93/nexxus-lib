const MessagingClient = require('./messaging_client');
const Application = require('../Application');
const kafka = require('kafka-node');
const async = require('async');

class KafkaClient extends MessagingClient {
	constructor (config, name, channel) {
		super(config, name, channel);

		async.series([
			callback => {
				this.connectionClient = kafka.Client(`${this.config.host}:${this.config.port}/${this.name}`);
				this.connectionClient.on('ready', () => {
					Application.logger.info('Client connected to Zookeeper & Kafka Messaging Client.');
					callback();
				});
				this.connectionClient.on('error', () => {
					Application.logger.error('Kafka broker not available. Trying to reconnect.');
				});
			},
			callback => {
				let groupId = this.broadcast ? this.name : channel;

				if (channel) {
					this.kafkaConsumer = new kafka.HighLevelConsumer(this.connectionClient, [{ topic: channel }], { groupId: groupId });
					this.kafkaConsumer.on('error', err => {
						console.log(err);
					});
				}

				callback();
			},
			callback => {
				this.kafkaProducer = new kafka.HighLevelProducer(this.connectionClient);
				this.kafkaProducer.on('error', () => { });
				callback();
			}
		], function (err) {
			if (err) {
				Application.logger.emergency(`Kafka Queue: ${err.toString()}`);
				process.exit(0);
			} else {
				if (this.onReadyFunc instanceof Function) {
					this.onReadyFunc();
				}
			}
		});
	}

	send (messages, channel, callback) {
		this.kafkaProducer.send([{
			topic: channel,
			messages: messages
		}], callback);
	}

	publish (messages, channel, callback) {
		this.send(messages, channel, callback);
	}

	onMessage (callback) {
		if (this.kafkaConsumer) {
			this.kafkaConsumer.on('message', message => {
				callback(message.value);
			});
		}
	}

	shutdown (callback) {
		this.connectionClient.close(callback);
	}

	consumerOn (event, callback) {
		if (this.kafkaConsumer) {
			this.kafkaConsumer.on(event, callback);
		}
	}

	producerOn (event, callback) {
		this.kafkaProducer.on(event, callback);
	}
}

module.exports = KafkaClient;
