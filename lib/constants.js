module.exports = {
	models: {
		fieldTypes: {
			int: 'int',
			float: 'float',
			string: 'string',
			geolocation: 'geolocation',
			array: 'array',
			object: 'object',
			bool: 'bool'
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
	CHANNEL_KEY_PREFIX: 'nxx',
	patch: {
		OP: {
			append: 'append',
			increment: 'increment',
			replace: 'replace',
			remove: 'remove'
		}
	}
};
