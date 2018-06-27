import * as Global from '../../global';
import {EventEmitter} from 'events';
import NexxusError = require('../NexxusError');
import {NexxusPromise} from '../../global';

interface MessagingClientConfig {
	exclusive: boolean
}

declare type MessageQueueConfig = MessagingClientConfig & Global.ServiceOptions

export declare abstract class MessagingClient extends EventEmitter {
	constructor(config: MessageQueueConfig);
	send(messages: Array<string>, channel: string): NexxusPromise<undefined>
	sendSystemMessages(to: string, action: string, messages: Array<string>): NexxusPromise<undefined>
	publish(messages: Array<string>, channel: string): NexxusPromise<undefined>
	shutdown(): NexxusPromise<undefined>
}
