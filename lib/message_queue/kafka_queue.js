const MessagingClient = require('./messaging_client');
const kafka = require('kafka-node');
const async = require('async');
const promisify = require('util').promisify;

let Services;

class KafkaClient extends MessagingClient {
	constructor (config, name, channel) {
		super(config);

		async.series([
			callback => {
				this.connectionClient = kafka.Client(`${this.config.host}:${this.config.port}/`, this.config.serviceName);
				this.connectionClient.on('ready', () => {
					Services.logger.info('Client connected to Zookeeper & Kafka Messaging Client.');
					callback();
				});
				this.connectionClient.on('error', () => {
					Services.logger.error('Kafka broker not available. Trying to reconnect.');
				});
			},
			callback => {
				let groupId = this.exclusive ? this.config.serviceName : this.config.serviceType;

				this.kafkaConsumer = new kafka.ConsumerGroup({
					host: `${this.config.host}:${this.config.port}/`,
					groupId
				}, this.config.exclusive ? this.config.serviceName : this.config.serviceType);
				this.kafkaConsumer.on('error', callback);
				this.kafkaConsumer.on('message', message => {
					this.emit(message.value);
				});

				callback();
			},
			callback => {
				this.kafkaProducer = new kafka.HighLevelProducer(this.connectionClient);
				this.kafkaProducer.on('error', callback);
				this.kafkaProducer.on('ready', callback);
			}
		], err => {
			if (err) {
				this.emit('error', err);
			} else {
				this.emit('ready');
			}
		});
	}

	send (messages, channel) {
		return promisify(this.kafkaProducer.send.bind(this.kafkaProducer))([{
			topic: channel,
			messages
		}]);
	}

	shutdown () {
		return promisify(this.connectionClient.close.bind(this.connectionClient))();
	}
}

module.exports = services => {
	Services = services;

	return KafkaClient;
};
