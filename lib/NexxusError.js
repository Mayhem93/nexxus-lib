const sprintf = require('sprintf-js').vsprintf;

Error.stackTraceLimit = Infinity;

class NexxusError extends Error {
	constructor (error, placeholders = []) {
		super(sprintf(errors[error].message, [placeholders]));
		Error.captureStackTrace(this, this);
		this.name = 'NexxusError';
		this.code = error;
		this.status = errors[error].status;
		this.args = placeholders;
	}
}

NexxusError.errors = {
	ServerNotAvailable: 'ServerNotAvailable',
	ServerFailure: 'ServerFailure',
	NoRouteAvailable: 'NoRouteAvailable',
	MissingRequiredField: 'MissingRequiredField',
	RequestBodyEmpty: 'RequestBodyEmpty',
	InvalidContentType: 'InvalidContentType',
	ApiKeySignatureMissing: 'ApiKeySignatureMissing',
	InvalidApikey: 'InvalidApikey',
	DeviceIdMissing: 'DeviceIdMissing',
	ApplicationIdMissing: 'ApplicationIdMissing',
	ApplicationNotFound: 'ApplicationNotFound',
	ApplicationForbidden: 'ApplicationForbidden',
	AuthorizationMissing: 'AuthorizationMissing',
	InvalidAuthorization: 'InvalidAuthorization',
	OperationNotAllowed: 'OperationNotAllowed',
	AdminBadLogin: 'AdminBadLogin',
	AdminAlreadyAuthorized: 'AdminAlreadyAuthorized',
	AdminDeauthorizeLastAdmin: 'AdminDeauthorizeLastAdmin',
	AdminNotFoundInApplication: 'AdminNotFoundInApplication',
	ContextNotFound: 'ContextNotFound',
	ContextNotAllowed: 'ContextNotAllowed',
	ApplicationSchemaModelNotFound: 'ApplicationSchemaModelNotFound',
	UserNotFound: 'UserNotFound',
	InvalidApplicationUser: 'InvalidApplicationUser',
	DeviceNotFound: 'DeviceNotFound',
	InvalidContext: 'InvalidContext',
	InvalidChannel: 'InvalidChannel',
	InsufficientFacebookPermissions: 'InsufficientFacebookPermissions',
	UserAlreadyExists: 'UserAlreadyExists',
	AdminAlreadyExists: 'AdminAlreadyExists',
	UserBadLogin: 'UserBadLogin',
	UnspecifiedError: 'UnspecifiedError',
	AdminNotFound: 'AdminNotFound',
	ObjectNotFound: 'ObjectNotFound',
	ParentObjectNotFound: 'ParentObjectNotFound',
	InvalidObjectRelationKey: 'InvalidObjectRelationKey',
	SubscriptionNotFound: 'SubscriptionNotFound',
	InvalidFieldValue: 'InvalidFieldValue',
	ClientBadRequest: 'ClientBadRequest',
	MalformedAuthorizationToken: 'MalformedAuthorizationToken',
	InvalidAdmin: 'InvalidAdmin',
	InvalidPatch: 'InvalidPatch',
	ApplicationHasNoSchema: 'ApplicationHasNoSchema',
	InvalidLoginProvider: 'InvalidLoginProvider',
	ServerNotConfigured: 'ServerNotConfigured',
	ExpiredAuthorizationToken: 'ExpiredAuthorizationToken',
	UnconfirmedAccount: 'UnconfirmedAccount',
	QueryError: 'QueryError',
	TilNotFound: 'TilNotFound',
	DeviceInvalid: 'DeviceInvalid',
	ServerConfigurationFailure: 'ServerConfigurationFailure',
	ErrorCollection: 'ErrorCollection',
	InvalidApplicationSchema: 'InvalidApplicationSchema'
};

const errors = {
	ServerNotAvailable: {
		message: 'The Telepat Service is unable to fulfil your request. Try again later',
		status: 503
	},
	ServerFailure: {
		message: 'Telepat Service error: %s',
		status: 500
	},
	NoRouteAvailable: {
		message: 'There is no route with this URL path',
		status: 404
	},
	MissingRequiredField: {
		message: 'Request body is missing a required field: %s',
		status: 400
	},
	RequestBodyEmpty: {
		message: 'Required request body is empty',
		status: 400
	},
	InvalidContentType: {
		message: 'Request content type must be application/json',
		status: 415
	},
	ApiKeySignatureMissing: {
		message: 'API key is missing from the request headers',
		status: 400
	},
	InvalidApikey: {
		message: 'API key is not valid for this application',
		status: 401
	},
	DeviceIdMissing: {
		message: 'Required device ID header is missing',
		status: 400
	},
	ApplicationIdMissing: {
		message: 'Required application ID header is missing',
		status: 400
	},
	ApplicationNotFound: {
		message: 'Requested application with ID "%s" does not exist',
		status: 404
	},
	ApplicationForbidden: {
		message: 'This application does not belong to you',
		status: 401
	},
	AuthorizationMissing: {
		message: 'Authorization header is not present',
		status: 401
	},
	InvalidAuthorization: {
		message: 'Invalid authorization: %s',
		status: 401
	},
	OperationNotAllowed: {
		message: 'You don\'t have the necessary privileges for this operation',
		status: 403
	},
	AdminBadLogin: {
		message: 'Wrong user email address or password',
		status: 401
	},
	AdminAlreadyAuthorized: {
		message: 'Admin with that email address is already authorized in this application',
		status: 409
	},
	AdminDeauthorizeLastAdmin: {
		message: 'Cannot remove yourself from the application because you\'re the only authorized admin',
		status: 409
	},
	AdminNotFoundInApplication: {
		message: 'Admin with email address %s does not belong to this application',
		status: 404
	},
	ContextNotFound: {
		message: 'Context not found',
		status: 404
	},
	ContextNotAllowed: {
		message: 'This context doesn\'t belong to you',
		status: 403
	},
	ApplicationSchemaModelNotFound: {
		message: 'Application with ID %s does not have a model named %s',
		status: 404
	},
	UserNotFound: {
		message: 'User not found',
		status: 404
	},
	InvalidApplicationUser: {
		message: 'User does not belong to this application',
		status: 404
	},
	DeviceNotFound: {
		message: 'Device with ID %s not found',
		status: 404
	},
	InvalidContext: {
		message: 'Context with id %s does not belong to app with id %s',
		status: 403
	},
	InvalidChannel: {
		message: 'Channel is invalid: %s',
		status: 400
	},
	InsufficientFacebookPermissions: {
		message: 'Insufficient facebook permissions: %s	',
		status: 400
	},
	UserAlreadyExists: {
		message: 'User already exists',
		status: 409
	},
	AdminAlreadyExists: {
		message: 'Admin already exists',
		status: 409
	},
	UserBadLogin: {
		message: 'User email address or password do not match',
		status: 401
	},
	UnspecifiedError: {
		message: 'Unspecified error',
		status: 500
	},
	AdminNotFound: {
		message: 'Admin not found',
		status: 404
	},
	ObjectNotFound: {
		message: 'Object with ID %s not found',
		status: 404
	},
	ParentObjectNotFound: {
		message: 'Unable to create: parent "%s" with ID "%s" does not exist',
		status: 404
	},
	InvalidObjectRelationKey: {
		message: 'Unable to create: parent relation key "%s" is not valid. Must be at most %s',
		status: 400
	},
	SubscriptionNotFound: {
		message: 'Subscription not found',
		status: 404
	},
	InvalidFieldValue: {
		message: 'Invalid field value: %s',
		status: 400
	},
	ClientBadRequest: {
		message: 'Generic bad request error: %s',
		status: 400
	},
	MalformedAuthorizationToken: {
		message: 'Malformed authorization token',
		status: 400
	},
	InvalidAdmin: {
		message: 'Invalid admin',
		status: 401
	},
	InvalidPatch: {
		message: 'Invalid patch: %s',
		status: 400
	},
	ApplicationHasNoSchema: {
		message: 'Could not fulfill request because application has no schema defined',
		status: 501
	},
	InvalidLoginProvider: {
		message: 'Invalid login provider. Possible choices: %s',
		status: 400
	},
	ServerNotConfigured: {
		message: 'Unable to fullfill request because the server has not been configured: "%s"',
		status: 501
	},
	ExpiredAuthorizationToken: {
		message: 'Expired authorization token',
		status: 401
	},
	UnconfirmedAccount: {
		message: 'This user account has not been confirmed',
		status: 403
	},
	QueryError: {
		message: 'Failed to parse query filter: %s',
		status: 400
	},
	TilNotFound: {
		message: 'TelepatIndexedList with name "%s" does not exist',
		status: 404
	},
	DeviceInvalid: {
		message: 'Device with ID %s is invalid: %s',
		status: 400
	},
	ServerConfigurationFailure: {
		message: 'Server configuration failure: %s',
		status: 500
	},
	InvalidApplicationSchema: {
		message: 'Invalid application schema: %s',
		status: 400
	},
	ErrorCollection: {
		message: 'Multiple errors occured: %s',
		status: 500
	}
};

module.exports = NexxusError;
