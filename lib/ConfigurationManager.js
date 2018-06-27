const dot = require('dot-object');
const validator = require('validator');
const NexxusLib = require('./NexxusLib');
const fs = require('fs');
const promisify = require('util').promisify;

const validate = Symbol('validate');
const loadExclusivityGroups = Symbol('loadExclusivityGroups');
const verifyVariable = Symbol('verifyVariable');
const typeVerifier = Symbol('typeVerifier');
const arrayTypeVerifier = Symbol('arrayTypeVerifier');
const enumVerifier = Symbol('enumVerifier');
const exclusivityVerifier = Symbol('exclusivityVerifier');

class ConfigurationManager {
	constructor (specFile, configFile) {
		this.specFile = specFile;

		this.configFile = configFile;
		/**
		 * This object holds the collection of all groups containing the grouped variables
		 * @type {{string}}
		 */
		this.exclusivityGroups = {};
		/**
		 *
		 * @type {{string[]}}
		 */
		this.foundExclusivevariables = {};
	}

	async load () {
		try {
			this.spec = JSON.parse(await promisify(fs.readFile)(this.specFile, {encoding: 'utf8'}));
			this.config = JSON.parse(await promisify(fs.readFile)(this.configFile, {encoding: 'utf8'}));
		} catch (e) {
			throw new NexxusLib(NexxusLib.errors.ServerConfigurationFailure, [e.message]);
		}

		this[loadExclusivityGroups]();
	}

	test () {
		return this[validate]();
	}

	[loadExclusivityGroups] (spec) {
		spec = spec || this.spec.root;

		for (const i in spec) {
			if (spec[i].exclusive_group) {
				if (!this.exclusivityGroups[spec[i].exclusive_group]) {
					this.exclusivityGroups[spec[i].exclusive_group] = [spec[i].name];
				} else {
					this.exclusivityGroups[spec[i].exclusive_group].push(spec[i].name);
				}
			}

			if (spec[i].root) {
				this[loadExclusivityGroups](spec[i].root);
			}
		}
	}

	/**
	*
	* @param {object} [spec]
	* @param {object} [config]
	* @returns {boolean|NexxusError}
	*/
	[validate] (spec, config, rootName) {
		let result = true;

		spec = spec || this.spec.root;
		config = config || this.config;
		rootName = rootName || '';

		for (const s in spec) {
			const varName = spec[s].name;

			if (spec[s].exclusive_group && config[spec[s].name]) {
				if (!this.foundExclusivevariables[spec[s].exclusive_group]) {
					this.foundExclusivevariables[spec[s].exclusive_group] = [varName];
				} else {
					this.foundExclusivevariables[spec[s].exclusive_group].push(varName);
				}
			}

			let varValue = config[spec[s].name];

			if (spec[s].env_const && process.env[spec[s].env_var] && !spec[s].root) {
				const theEnvVar = process.env[spec[s].env_var];

				if (spec[s].type === 'array') {
					varValue = theEnvVar ? theEnvVar.split(' ') : undefined;
				} else if (spec[s].type === 'bool') {
					varValue = !!theEnvVar;
				} else {
					varValue = theEnvVar;
				}
				config[spec[s].name] = varValue;
			} else if (spec[s].root && !spec[s].optional && !varValue) {
				config[spec[s].name] = varValue = {};
			}

			result = result && this[verifyVariable](varValue, spec[s], rootName);

			if (result instanceof NexxusLib) {
				throw result;
			}
		}

		return result;
	}

	/**
	*
	* @param {*} variable
	* @param {Object} specVariable
	* @param {string} specvariable.name Name of the variable
	* @param {string} specvariable.env_const Name of the environment variable to check for, if it's not present in the file
	* @param {string} specvariable.type The type of the variable (int, float, array, object, string, bool)
	* @param {string} specvariable.array_type The type of the array's elements
	* @param {string} specvariable.optional The test passes if the variable is not set, null or empty
	* @param {string} specvariable.exclusive_group Exclusivity group for a config variable. Only 1 variable can be in this
	* group.
	* @param {array} specvariable.enum This variable can only have these values
	* @param {Object} specvariable.required_by This variable is verified only when a specific variable has a certain value
	* @param {array} specvariable.root Allows for nested objects
	* @return {boolean|NexxusError} true if variable passed or an error describing the problem if it didn't pass
	*/
	[verifyVariable] (variable, specVariable, rootName) {
		if (!specVariable.name) {
			console.log(`Spec file "${this.specFile} has a variable which is missing the "name" property`);

			return true;
		}

		const fullVarName = `${rootName}.${specVariable.name}`;

		if (specVariable.required_by) {
			const requiredletName = Object.keys(specVariable.required_by)[0];
			const requiredletValue = specVariable.required_by[requiredletName];

			if (dot.pick(requiredletName, this.config) !== requiredletValue) {
				return true;
			}
		}

		// because nested objects don't have environment variables (only their children) we need to simmulate an empty object
		// in the loaded configuration
		if (specVariable.root && variable instanceof Object && !Object.keys(variable).length) {
			return this[validate](specVariable.root, dot.pick(fullVarName.slice(1), this.config), fullVarName);
		}

		if (specVariable.optional) {
			return true;
		} else if (!variable && !specVariable.exclusive_group) {
			// if the value in the config file doen't exist and it also doesn't belong in a exclusive group, it means that it's
			// a mandatory config const which is missing

			return new NexxusLib(NexxusLib.errors.ServerConfigurationFailure, [`${fullVarName} is mising from the configuration`]);
		} else if (!variable && specVariable.exclusive_group) {
			return true;
		}

		if (specVariable.enum && !this[enumVerifier](variable, specVariable.enum)) {
			return new NexxusLib(NexxusLib.errors.ServerConfigurationFailure, [
				`${fullVarName} can only have these values: "${specVariable.enum.join(' ')}"`]);
		}

		if (!this[typeVerifier](variable, specVariable.type)) {
			return new NexxusLib(NexxusLib.errors.ServerConfigurationFailure, [
				`Invalid type for variable ${fullVarName}, must be "${specVariable.type}"`]);
		}

		if (specVariable.array_type && !this[arrayTypeVerifier](variable, specVariable.array_type)) {
			return new NexxusLib(NexxusLib.errors.ServerConfigurationFailure, [
				`Invalid type for variable ${fullVarName} or array has wrong type for its elements`]);
		}

		if (specVariable.exclusive_group) {
			// !(if the value doesn't exist in the config file but it's a part of an exclusive group)
			if (!(!variable && this.foundExclusivevariables[specVariable.exclusive_group]) && !this[exclusivityVerifier](specVariable.exclusive_group)) {
				return new NexxusLib(NexxusLib.errors.ServerConfigurationFailure, [
					`At most one of these variables "${this.exclusivityGroups[specVariable.exclusive_group].join(' ')}" can be present`]);
			}
		}

		return specVariable.root ? this[validate](specVariable.root, dot.pick(fullVarName.slice(1), this.config), fullVarName) : true;
	}

	/**
	*
	* @param {*} variable
	* @param {string} type
	* @returns {boolean}
	*/
	[typeVerifier] (variable, type) {
		switch (type) {
			case 'int': {
				return validator.isInt('' + variable);
			}

			case 'float': {
				return validator.isFloat('' + variable);
			}

			case 'array': {
				return Array.isArray(variable);
			}

			case 'object': {
				return (variable instanceof Object);
			}

			case 'string': {
				return (typeof variable) === 'string';
			}

			case 'bool': {
				return (typeof variable) === 'boolean';
			}

			default:
				return true;
		}
	}
	/**
	 * Checks the elements of an array if the are of the same specified type
	 * @param {*} array
	 * @param {string} type
	 * @returns {boolean} True of all elements pass the type test
	 */
	[arrayTypeVerifier] (array, type) {
		if (!Array.isArray(array)) {
			return false;
		}

		for (const i in array) {
			if (!this[typeVerifier](array[i], type)) {
				return false;
			}
		}

		return true;
	}
	/**
	 * Checks if the value is found in the enum array
	 * @param {*} value
	 * @param {Array} array
	 * @returns {boolean} True of all elements pass the type test
	 */
	[enumVerifier] (value, array) {
		return array.indexOf(value) !== -1;
	}

	/**
	 * Verifies if the group hasn't been already created. Only one variable in this group should exist.
	 * @param {string} group
	 * @returns {boolean} returns true if the group is empty
	*/
	[exclusivityVerifier] (group) {
		// we use .length == 1 because in _validate() we insert this variable here before calling this function
		return this.foundExclusivevariables[group] && this.foundExclusivevariables[group].length === 1;
	}
}

module.exports = ConfigurationManager;
