import * as Global from './global';
import NexxusAdmin = require('./lib/Admin');
import NexxusApplication = require('./lib/Application')
import NexxusError = require('./lib/NexxusError');
import NexxusUser = require('./lib/User');
import Datasource = require('./lib/database/datasource');
import MessagingClient = require('./lib/message_queue/messaging_client');
import Services = require('./lib/Services');

declare interface NexxusLibInterface {
	init(serviceOptions: Global.ServiceOptions): Global.NexxusPromise<null>
	config: Global.ServiceOptions
	constants: Global.constants
	Services: typeof Services
	NexxusAdmin: NexxusAdmin
	NexxusApplication: NexxusApplication & ((id: string) => NexxusApplication)
	NexxusError: NexxusError
	NexxusSubscription: any
	NexxusUser: NexxusUser
}

declare const NexxusLib: NexxusLibInterface

export = NexxusLib
