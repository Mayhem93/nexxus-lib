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

declare class NexxusError extends Error {
	static errors: ERRORS;

	constructor(err: ERRORS, placeholders?: Array<string>);
}

export = NexxusError;
