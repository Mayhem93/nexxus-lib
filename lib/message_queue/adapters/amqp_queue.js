const MessagingClient = require('../messaging_client');
const amqplib = require('amqplib');
const async = require('async');
const lz4 = require('../../../utils/utils').lz4;
const Services = require('../../Services');

class AMQPClient extends MessagingClient {
	constructor (config) {
		super(config);

		this.amqpChannel = null;
		this.broadcastQueue = null;
		this.assertedQueues = {};

		const tryConnect = async () => {
			try {
				this.connectionClient = await amqplib.connect(`amqp://${this.config.user}:${this.config.password}@${this.config.host}`);
			} catch (err) {
				Services.logger.error(`Failed connecting to AMQP messaging queue (${err.toString()}). Retrying... `);

				setTimeout(async () => { await tryConnect(); }, 1000);
			}
		};

		async.series([
			tryConnect,
			async () => {
				this.amqpChannel = await this.connectionClient.createChannel();

				// create queue or exchange if it doesnt exist; used for consumers
				if (this.config.exclusive) {
					await this.amqpChannel.assertExchange(`${this.config.serviceType}-exchange`, 'fanout', {});
					this.broadcastQueue = await this.amqpChannel.assertQueue(this.config.serviceName, { durable: false, autoDelete: true });
					await this.amqpChannel.bindQueue(this.broadcastQueue, `${this.config.serviceType}-exchange`, '', {});
				} else {
					await this.amqpChannel.assertQueue(this.config.serviceType, {});
				}
			},
			async () => {
				await this.amqpChannel.bindQueue(this.broadcastQueue || this.config.serviceType, 'amq.fanout', '', {});
				Services.logger.info('Connected to AMQP Messaging Queue');
			}
		], err => {
			if (err) {
				this.emit('error', err);
			} else {
				let fromWhere = this.exclusive ? this.broadcastQueue : this.config.serviceType;

				this.amqpChannel.consume(fromWhere, async message => {
					if (message) {
						const parsedData = JSON.parse(await lz4.decompress(message.content));

						if (!parsedData._systemMessage) {
							this.emit('message', parsedData);
						} else {
							this.emit('systemMessage', parsedData);
						}
					}
				}, { noAck: true });

				this.emit('ready');
			}
		});
	}

	async send (messages, channel) {
		if (this.assertedQueues[channel]) {
			await this.amqpChannel.checkQueue(channel);
		}

		await messages.reduce(async (p, message) => {
			await p;

			const compressed = await lz4.compress(message);

			return this.amqpChannel.sendToQueue(channel, compressed);
		}, Promise.resolve());
	}

	async sendSystemMessages (to, action, messages) {
		if (this.failedBind) {
			return null;
		}

		await messages.reduce(async (p, message) => {
			await p;

			let messagePayload = {
				_systemMessage: true,
				to,
				action,
				content: message
			};

			const compressed = await lz4.compress(JSON.stringify(messagePayload));

			return this.amqpChannel.publish('amq.fanout', '', compressed);
		}, Promise.resolve());

		return null;
	}

	async publish (messages, channel) {
		if (this.assertedQueues[`${channel}-exchange`]) {
			await this.amqpChannel.assertExchange(`${channel}-exchange`, 'fanout', {});

			this.assertedQueues[`${channel}-exchange`] = true;
		}

		await messages.reduce(async (p, message) => {
			await p;

			const compressed = lz4.compress(message);

			return this.amqpChannel.publish(`${channel}-exchange`, '', compressed);
		}, Promise.resolve());
	}

	shutdown () {
		return this.amqpChannel.close();
	}
}

module.exports = AMQPClient;
