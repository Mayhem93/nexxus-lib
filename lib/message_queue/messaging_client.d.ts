import * as Global from '../../global';
import {EventEmitter} from 'events';
import TelepatError = require('../TelepatError');
import {TelepatPromise} from '../../global';

interface MessagingClientConfig {
	exclusive: boolean
}

declare type MessageQueueConfig = MessagingClientConfig & Global.ServiceOptions

export declare abstract class MessagingClient extends EventEmitter {
	constructor(config: MessageQueueConfig);
	send(messages: Array<string>, channel: string): TelepatPromise<undefined>
	sendSystemMessages(to: string, action: string, messages: Array<string>): TelepatPromise<undefined>
	publish(messages: Array<string>, channel: string): TelepatPromise<undefined>
	shutdown(): TelepatPromise<undefined>
}
