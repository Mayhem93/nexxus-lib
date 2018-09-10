import NexxusDevice = require('./Device')

interface NexxusSubscriptionConstructor {
	readonly prototype: NexxusSubscription
	new(channel: object): NexxusSubscription
	getChannel(): string
}

interface NexxusSubscription {
	removeAllSubscriptionsFromDevice(applicationId: string, deviceId: string, token: string, transport: string): void
	getAllDevices(applicationId: string): Map<string, Array<NexxusDevice>>
	getSubscriptionKeysWithFilters(channel: object): Array<object>
}

declare const NexxusSubscriptionConstructor: NexxusSubscriptionConstructor & NexxusSubscription

export = NexxusSubscriptionConstructor
