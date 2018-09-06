import NexxusLogger = require('./logger/logger');
import MessagingClient = require('./message_queue/messaging_client');
import Datasource = require('./database/datasource');

declare interface Services {
	logger: InstanceType<NexxusLogger>;
	messagingClient: InstanceType<MessagingClient>;
	datasource: InstanceType<Datasource>;
}

declare const NexxusServices: Services

export = NexxusServices
