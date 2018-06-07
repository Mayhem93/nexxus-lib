import * as Global from './global';
import TelepatError = require('./lib/TelepatError');
import {TelepatLogger} from './lib/logger/logger';
import {Datasource} from './lib/database/datasource';
import {MessagingClient} from './lib/message_queue/messaging_client';

declare namespace TelepatLib {
	export function init(serviceOptions: Global.ServiceOptions): Global.TelepatPromise<null>;
	export const config: object;
	export const logger: TelepatLogger;
	export const messagingClient: MessagingClient;
	export const TelepatError;
}

export = TelepatLib;
