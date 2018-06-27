import * as Global from './global';
import NexxusError = require('./lib/NexxusError');
import {NexxusLogger} from './lib/logger/logger';
import {Datasource} from './lib/database/datasource';
import {MessagingClient} from './lib/message_queue/messaging_client';

declare namespace NexxusLib {
	export function init(serviceOptions: Global.ServiceOptions): Global.NexxusPromise<null>;
	export const config: object;
	export const logger: NexxusLogger;
	export const messagingClient: MessagingClient;
	export const NexxusError;
}

export = NexxusLib;
