const dot = require('dot-object');
const validator = require('validator');
const TelepatError = require('./TelepatError');
const async = require('async');
const fs = require('fs');

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

	load (callback) {
		async.series([
			callback1 => {
				fs.readFile(this.specFile, {encoding: 'utf8'}, (err, contents) => {
					if (err) {
						callback1(TelepatError(TelepatError.errors.ServerConfigurationFailure, [err.message]));
					} else {
						this.spec = JSON.parse(contents);
						callback1();
					}
				});
			},
			callback1 => {
				fs.readFile(this.configFile, {encoding: 'utf8'}, (err, contents) => {
					if (err) {
						callback1(TelepatError(TelepatError.errors.ServerConfigurationFailure, [err.message]));
					} else {
						this.config = JSON.parse(contents);
						callback1();
					}
				});
			}
		], err => {
			if (err) {
				throw err;
			} else {
				this.loadExclusivityGroups();
				callback();
			}
		});
	}

	loadExclusivityGroups (spec) {
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
				this.loadExclusivityGroups(spec[i].root);
			}
		}
	}

	/**
	*
	* @param {object} [spec]
	* @param {object} [config]
	* @returns {boolean|TelepatError}
	*/
	validate (spec, config, rootName) {
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

			result = result && this.verifyvariable(varValue, spec[s], rootName);

			if (result instanceof TelepatError) {
				return result;
			}
		}

		return result;
	}

	test () {
		return this.validate();
	}

	/**
	*
	* @param {*} variable
	* @param {Object} specvariable
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
	* @return {boolean|TelepatError} true if variable passed or an error describing the problem if it didn't pass
	*/
	verifyVariable (variable, specvariable, rootName) {
		if (!specvariable.name) {
			console.log(`Spec file "${this.specFile} has a variable which is missing the "name" property`);

			return true;
		}

		const fullVarName = rootName + '.' + specvariable.name;

		if (specvariable.required_by) {
			const requiredletName = Object.keys(specvariable.required_by)[0];
			const requiredletValue = specvariable.required_by[requiredletName];

			if (dot.pick(requiredletName, this.config) !== requiredletValue) {
				return true;
			}
		}

		// because nested objects don't have environment variables (only their children) we need to simmulate an empty object
		// in the loaded configuration
		if (specvariable.root && variable instanceof Object && !Object.keys(variable).length) {
			return this.validate(specvariable.root, dot.pick(fullVarName.slice(1), this.config), fullVarName);
		}

		if (specvariable.optional) {
			return true;
		} else if (!variable && !specvariable.exclusive_group) {
			// if the value in the config file doen't exist and it also doesn't belong in a exclusive group, it means that it's
			// a mandatory config const which is missing

			return new TelepatError(TelepatError.errors.ServerConfigurationFailure, [`${fullVarName} is mising from the configuration`]);
		} else if (!variable && specvariable.exclusive_group) {
			return true;
		}

		if (specvariable.enum && !this.enumVerifier(variable, specvariable.enum)) {
			return new TelepatError(TelepatError.errors.ServerConfigurationFailure, [
				`${fullVarName} can only have these values: "${specvariable.enum.join(' ')}"`]);
		}

		if (!this.typeVerifier(variable, specvariable.type)) {
			return new TelepatError(TelepatError.errors.ServerConfigurationFailure, [
				`Invalid type for variable ${fullVarName}, must be "${specvariable.type}"`]);
		}

		if (specvariable.array_type && !this.arrayTypeVerifier(variable, specvariable.array_type)) {
			return new TelepatError(TelepatError.errors.ServerConfigurationFailure, [
				`Invalid type for variable ${fullVarName} or array has wrong type for its elements`]);
		}

		if (specvariable.exclusive_group) {
			// !(if the value doesn't exist in the config file but it's a part of an exclusive group)
			if (!(!variable && this.foundExclusivevariables[specvariable.exclusive_group]) && !this.exclusivityVerifier(specvariable.exclusive_group)) {
				return new TelepatError(TelepatError.errors.ServerConfigurationFailure, [
					`At most one of these variables "${this.exclusivityGroups[specvariable.exclusive_group].join(' ')}" can be present`]);
			}
		}

		return specvariable.root ? this.validate(specvariable.root, dot.pick(fullVarName.slice(1), this.config), fullVarName) : true;
	}

	/**
	*
	* @param {*} variable
	* @param {string} type
	* @returns {boolean}
	*/
	typeVerifier (variable, type) {
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
	arrayTypeVerifier (array, type) {
		if (!Array.isArray(array)) {
			return false;
		}

		for (const i in array) {
			if (!this.typeVerifier(array[i], type)) {
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
	enumVerifier (value, array) {
		return array.indexOf(value) !== -1;
	}

	/**
	 * Verifies if the group hasn't been already created. Only one variable in this group should exist.
	 * @param {string} group
	 * @returns {boolean} returns true if the group is empty
	*/
	exclusivityVerifier (group) {
		// we use .length == 1 because in _validate() we insert this variable here before calling this function
		return this.foundExclusivevariables[group] && this.foundExclusivevariables[group].length === 1;
	}
}

module.exports = ConfigurationManager;
