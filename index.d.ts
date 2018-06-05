import * as Global from './global';
import {TelepatError} from './lib/TelepatError';
import {Datasource} from './lib/database/datasource';
import {MessagingClient} from './lib/message_queue/messaging_client';

declare namespace TelepatLib {
	export function init(serviceOptions: ServiceOptions): Global.TelepatPromise<null, TelepatError>;
	export const TelepatError;
}

interface TelepatServices {
	datasource: Datasource,
	logger: null,
	messagingClient: MessagingClient,
	redisCacheClient: null
}

interface ServiceOptions {
	serviceType: string,
	nodeIndex: number,
	configFile: string,
	configFileSpec: string
}

export = TelepatLib;
