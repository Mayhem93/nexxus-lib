var TelepatError = require('../lib/TelepatError');

var BuilderNode = function(name) {
	if (BuilderNode.CONNECTORS.indexOf(name) === -1) {
		throw new TelepatError(TelepatError.errors.QueryError, ['unsupported query connector "'+name+'"']);
	}

	this.parent = null;
	/**
	 *
	 * @type {BuilderNode[]|Object[]}
	 */
	this.children = [];
	this.name = name;
};

BuilderNode.CONNECTORS = [
	'and',
	'or'
];

BuilderNode.FILTERS = [
	'is',
	'not',
	'exists',
	'range',
	'in_array',
	'like'
];

/**
 * @param {string} name
 * @param {Object|string} value
 */
BuilderNode.prototype.addFilter = function(name, value) {
	if (BuilderNode.FILTERS.indexOf(name) !== -1) {
		if (value === undefined) {
			throw new TelepatError(TelepatError.errors.QueryError, ['filter value is undefined']);
		}

		if (name === 'exists' && typeof value !== 'string') {
			throw new TelepatError(TelepatError.errors.QueryError, ['filter value for "exists" must be a string']);
		}

		if (['is', 'not', 'range', 'in_array', 'like'].indexOf(name) !== -1 && typeof value !== 'object') {
			throw new TelepatError(TelepatError.errors.QueryError, ['filter value for "' + name + '" must be an object']);
		}

		var filter = {};
		filter[name] = value;

		this.children.push(filter);
	} else {
		throw new TelepatError(TelepatError.errors.QueryError, ['invalid filter "'+name+'"']);
	}
};

/**
 *
 * @param {BuilderNode} node
 */
BuilderNode.prototype.addNode = function(node) {
	if (!(node instanceof BuilderNode)) {
		throw new TelepatError(TelepatError.errors.ServerFailure,
			['BuilderNode.addNode: argument must be instanceof BuilderNode']);
	}

	node.parent = this;
	this.children.push(node);
};

/**
 *
 * @param {BuilderNode} node
 */
BuilderNode.prototype.removeNode = function(node) {
	if (!(node instanceof BuilderNode)) {
		throw new TelepatError(TelepatError.errors.ServerFailure,
			['BuilderNode.addNode: argument must be instanceof BuilderNode']);
	}

	var idx = this.children.indexOf(node);

	if (idx !== -1) {
		node.parent = null;
		return this.children.splice(idx, 1)[0];
	} else {
		return null;
	}
};

BuilderNode.prototype.toObject = function() {
	var obj = {};
	obj[this.name] = [];

	this.children.forEach(function(item) {
		if (item instanceof BuilderNode)
			obj[this.name].push(item.toObject());
		else
			obj[this.name].push(item);
	}, this);

	return obj;
};

var FilterBuilder = function(initial) {
	/**
	 *
	 * @type {null|BuilderNode}
	 */
	this.root = null;

	if (initial) {
		this.root = new BuilderNode(initial);
	} else {
		this.root = new BuilderNode('and');
	}

	this.pointer = this.root;
};

FilterBuilder.prototype.and = function() {
	var child = new BuilderNode('and');
	this.pointer.addNode(child);
	this.pointer = child;

	return this;
};

FilterBuilder.prototype.or = function() {
	var child = new BuilderNode('or');
	this.pointer.addNode(child);
	this.pointer = child;

	return this;
};

FilterBuilder.prototype.addFilter = function(name, value) {
	this.pointer.addFilter(name, value);

	return this;
};

FilterBuilder.prototype.removeNode = function() {
	if (this.root !== this.pointer) {
		var nodeToRemove = this.pointer;
		this.pointer = this.pointer.parent;

		return this.pointer.removeNode(nodeToRemove);
	} else
		return null;
};

FilterBuilder.prototype.isEmpty = function() {
	return this.root.children.length ? false : true;
};

FilterBuilder.prototype.end = function() {
	if (this.pointer.parent)
		this.pointer = this.pointer.parent;

	return this;
};

FilterBuilder.prototype.build = function() {
	return this.root.toObject();
};

module.exports = {
	FilterBuilder: FilterBuilder,
	BuilderNode: BuilderNode
};
