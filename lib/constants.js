module.exports = {
	models: {
		fieldTypes: {
			INT: 'int',
			FLOAT: 'float',
			STRING: 'string',
			GEOLOCATION: 'geolocation',
			ARRAY: 'array',
			OBJECT: 'object',
			BOOL: 'bool'
		},
		BaseModel: {
			reservedFieldNames: ['id', 'type', 'modified', 'created']
		},
		Application: {
			reservedFieldNames: ['keys', 'admins']
		},
		Context: {
			reservedFieldNames: ['application_id']
		},
		ApplicationModel: {
			reservedFieldNames: ['application_id', 'context_id']
		}
	},
	builtinModels: ['application', 'admin', 'user', 'context'],
	CHANNEL_KEY_PREFIX: 'nxx'
};
