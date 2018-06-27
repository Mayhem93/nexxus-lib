import {NexxusLogger} from './logger/logger';
import {MessagingClient} from './message_queue/messaging_client';
import {Datasource} from './database/datasource';
import {RedisClient} from 'redis';

export const logger: NexxusLogger;
export const messagingClient: MessagingClient;
export const datasource: Datasource;
export const redisClient: RedisClient;
