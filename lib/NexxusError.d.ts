type ERRORS = 'ServerNotAvailable' |
	'ServerFailure' |
	'NoRouteAvailable' |
	'MissingRequiredField' |
	'RequestBodyEmpty' |
	'InvalidContentType' |
	'ApiKeySignatureMissing' |
	'InvalidApikey' |
	'DeviceIdMissing' |
	'ApplicationIdMissing' |
	'ApplicationNotFound' |
	'ApplicationForbidden' |
	'AuthorizationMissing' |
	'InvalidAuthorization' |
	'OperationNotAllowed' |
	'AdminBadLogin' |
	'AdminAlreadyAuthorized' |
	'AdminDeauthorizeLastAdmin' |
	'AdminNotFoundInApplication' |
	'ContextNotFound' |
	'ContextNotAllowed' |
	'ApplicationSchemaModelNotFound' |
	'UserNotFound' |
	'InvalidApplicationUser' |
	'DeviceNotFound' |
	'InvalidContext' |
	'InvalidChannel' |
	'InsufficientFacebookPermissions' |
	'UserAlreadyExists' |
	'AdminAlreadyExists' |
	'UserBadLogin' |
	'UnspecifiedError' |
	'AdminNotFound' |
	'ObjectNotFound' |
	'ParentObjectNotFound' |
	'InvalidObjectRelationKey' |
	'SubscriptionNotFound' |
	'InvalidFieldValue' |
	'ClientBadRequest' |
	'MalformedAuthorizationToken' |
	'InvalidAdmin' |
	'InvalidPatch' |
	'ApplicationHasNoSchema' |
	'InvalidLoginProvider' |
	'ServerNotConfigured' |
	'ExpiredAuthorizationToken' |
	'UnconfirmedAccount' |
	'QueryError' |
	'TilNotFound' |
	'DeviceInvalid' |
	'ServerConfigurationFailure' |
	'ErrorCollection' |
	'InvalidApplicationSchema';

declare interface NexxusErrorConstructor extends Error {
	readonly prototype: NexxusError
	new(err: ERRORS, placeholders?: Array<string> | string): NexxusError
	errors: ERRORS;
}

declare interface NexxusError extends Error {
	name: string,
	code: string,
	placeholders: Array<string>
	message: string
}

declare const NexxusErrorConstructor : NexxusErrorConstructor & NexxusError

export = NexxusErrorConstructor;
