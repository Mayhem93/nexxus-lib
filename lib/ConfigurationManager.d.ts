interface NexxusConfigurationManagerConstructor {
	readonly prototype: NexxusConfigurationManager
	new(specFile: string, configFile: string): NexxusConfigurationManager

	load(): void
	test: boolean
}

interface NexxusConfigurationManager {}

declare const NexxusConfigurationManagerConstructor: NexxusConfigurationManagerConstructor & NexxusConfigurationManager

export = NexxusConfigurationManagerConstructor
