import * as Global from '../../global';
import {EventEmitter} from 'events';
import NexxusError = require('../NexxusError');
import {NexxusPromise} from '../../global';

interface MessagingClientConfig {
	exclusive: boolean
}

declare type MessageQueueConfig = MessagingClientConfig & Global.ServiceOptions

declare interface MessagingClientConstructor {
	readonly prototype: MessagingClient
	new(config: MessageQueueConfig): MessagingClient
}

declare interface MessagingClient extends EventEmitter {
	send(messages: Array<string>, channel: string): NexxusPromise<undefined>
	sendSystemMessages(to: string, action: string, messages: Array<string>): NexxusPromise<undefined>
	publish(messages: Array<string>, channel: string): NexxusPromise<undefined>
	shutdown(): NexxusPromise<undefined>
}

export = MessagingClientConstructor
