module.exports = {
	models: {
		fieldTypes: {
			INT: 'INT',
			FLOAT: 'FLOAT',
			STRING: 'STRING',
			GEOLOCATION: 'GEOLOCATION',
			ARRAY: 'ARRAY',
			OBJECT: 'OBJECT',
			BOOL: 'BOOL'
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
	builtinModels: ['application', 'admin', 'user', 'user_metadata', 'context'],
	CHANNEL_KEY_PREFIX: 'nxx'
};
