import * as Global from './global';
import NexxusAdmin = require('./lib/Admin');
import NexxusApplication = require('./lib/Application')
import NexxusApplicationSchema = require('./lib/ApplicationSchema');
import NexxusError = require('./lib/NexxusError');
import NexxusUser = require('./lib/User');
import NexxusPatch = require('./lib/Patch');
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
	NexxusApplicationSchema: typeof NexxusApplicationSchema
	NexxusError: NexxusError
	NexxusSubscription: any
	NexxusUser: NexxusUser,
	NexxusPatch: NexxusPatch
}

declare const NexxusLib: NexxusLibInterface

export = NexxusLib
