import NexxusSubscription = require('./Subscription')

interface NexxusDeviceVolatileTransportSettings {
	active: boolean
	server_name: string
	token: string
}

interface NexxusDevicePersistentTransportSettings {
	type: string
	token: string
}

interface NexxusDeviceConstructorParams {
	volatile?: NexxusDeviceVolatileTransportSettings
	persistent?: NexxusDevicePersistentTransportSettings
	info?: {udid?: string}
}

interface NexxusDeviceProperties extends NexxusDeviceConstructorParams {
	id: string
	application_id: string
	subscriptions?: Array<NexxusSubscription>
}

interface NexxusDeviceConstructor {
	readonly prototype: NexxusDevice
	new(applicationId: string, properties: NexxusDeviceConstructorParams)

	props: NexxusDeviceProperties

	isVolatileTransportActive(): boolean
	hasPersistentTransport(): boolean
	getToken(): string
	getTransportType(): string
	getSubscriptions(): Array<NexxusSubscription>
	addSubscription(channel: object): NexxusSubscription
	removeSubscription(subscription: NexxusSubscription): void
	removeSubscription(subscription: NexxusSubscription, token: string): void
	update(props: NexxusDeviceProperties): void
	remove(): void
}

interface NexxusDevice {
	create(properties: NexxusDeviceConstructorParams): NexxusDevice
	get(applicationId: string, id: string): NexxusDevice
	getByUdid(applicationId: string, udid: string): NexxusDevice
	removeById(applicationId: string, id: string): void
	updateById(applicationId: string, id: string): void
	getSubscriptionByDevice(applicationId: string, id: string): Array<NexxusSubscription>
}

declare const NexxusDeviceConstructor: NexxusDeviceConstructor & NexxusDevice

export = NexxusDeviceConstructor
