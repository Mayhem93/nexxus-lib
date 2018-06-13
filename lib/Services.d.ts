import {TelepatLogger} from './logger/logger';
import {MessagingClient} from './message_queue/messaging_client';
import {Datasource} from './database/datasource';
import {RedisClient} from 'redis';

export const logger: TelepatLogger;
export const messagingClient: MessagingClient;
export const datasource: Datasource;
export const redisCacheClient: RedisClient;
