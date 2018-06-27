const NexxusError = require('../lib/NexxusError');

class BuilderNode {
	constructor (name) {
		if (!BuilderNode.CONNECTORS.includes(name)) {
			throw new NexxusError(NexxusError.errors.QueryError, [`unsupported query connector "${name}"`]);
		}

		this.parent = null;
		/**
		 *
		 * @type {BuilderNode[]|Object[]}
		 */
		this.children = [];
		this.name = name;
	}

	addFilter (name, value) {
		if (BuilderNode.FILTERS.indexOf(name) !== -1) {
			if (value === undefined) {
				throw new NexxusError(NexxusError.errors.QueryError, ['filter value is undefined']);
			}

			if (name === 'exists' && typeof value !== 'string') {
				throw new NexxusError(NexxusError.errors.QueryError, ['filter value for "exists" must be a string']);
			}

			if (['is', 'not', 'range', 'in_array', 'like'].indexOf(name) !== -1 && typeof value !== 'object') {
				throw new NexxusError(NexxusError.errors.QueryError, [`filter value for "${name}" must be an object`]);
			}

			const filter = {};

			filter[name] = value;
			this.children.push(filter);
		} else {
			throw new NexxusError(NexxusError.errors.QueryError, [`invalid filter "${name}"`]);
		}
	}

	/**
	 *
	 * @param {BuilderNode} node
	 */
	addNode (node) {
		if (!(node instanceof BuilderNode)) {
			throw new NexxusError(NexxusError.errors.ServerFailure,
				['BuilderNode.addNode: argument must be instanceof BuilderNode']);
		}

		node.parent = this;
		this.children.push(node);
	}

	/**
	 *
	 * @param {BuilderNode} node
	 */
	removeNode (node) {
		if (!(node instanceof BuilderNode)) {
			throw new NexxusError(NexxusError.errors.ServerFailure,
				['BuilderNode.addNode: argument must be instanceof BuilderNode']);
		}

		let idx = this.children.indexOf(node);

		if (idx !== -1) {
			node.parent = null;

			return this.children.splice(idx, 1)[0];
		}

		return null;
	}

	toObject () {
		let obj = {};

		obj[this.name] = [];

		this.children.forEach(item => {
			if (item instanceof BuilderNode) {
				obj[this.name].push(item.toObject());
			} else {
				obj[this.name].push(item);
			}
		});

		return obj;
	}
}

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

class FilterBuilder {
	constructor (initial) {
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
	}

	and () {
		if (this.root === null) {
			this.root = new BuilderNode('and');
		} else {
			let child = new BuilderNode('and');

			this.pointer.addNode(child);
			this.pointer = child;
		}

		return this;
	}

	or () {
		if (this.root === null) {
			this.root = new BuilderNode('or');
		} else {
			let child = new BuilderNode('or');

			this.pointer.addNode(child);
			this.pointer = child;
		}

		return this;
	}

	addFilter (name, value) {
		this.pointer.addFilter(name, value);

		return this;
	}

	removeNode () {
		if (this.root !== this.pointer) {
			let nodeToRemove = this.pointer;

			this.pointer = this.pointer.parent;

			return this.pointer.removeNode(nodeToRemove);
		}

		return null;
	}

	isEmpty () {
		return !!this.root.children.length;
	}

	end () {
		if (this.pointer.parent) {
			this.pointer = this.pointer.parent;
		}

		return this;
	}

	build () {
		if (this.isEmpty()) {
			throw new NexxusError(NexxusError.errors.QueryError,
				[`cannot build query with empty filter (${JSON.stringify(this.root.toObject())})`]);
		}

		return this.root.toObject();
	}
}

module.exports = {
	FilterBuilder,
	BuilderNode
};
