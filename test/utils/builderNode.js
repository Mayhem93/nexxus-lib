var builderNode = require('../../utils/filterbuilder').BuilderNode;
var FilterBuilder = require('../../utils/filterbuilder').FilterBuilder;
var TelepatError = require('../../lib/TelepatError');
var chai = require('chai');
var expect = chai.expect;
var assert = chai.assert;
chai.should();
chai.use(require('chai-things'));

module.exports = function() {
	describe('BuilderNode', function() {
		after(afterTest);

		it('Should throw an error because connector is not valid', function(done) {
			try {
				var bn = new builderNode('wtf');
				assert.fail(undefined, TelepatError, 'Expected builderNode constructor to throw error');
			} catch (e) {
				if (e instanceof TelepatError) {
						expect(e).to.have.property('code', '048');
				} else {
					throw e;
				}

				try {
					var bn1 = new builderNode();
					assert.fail(undefined, TelepatError, 'Expected builderNode constructor to throw error');
				} catch (e1) {
					if (e1 instanceof TelepatError) {
						expect(e1).to.have.property('code', '048');
					} else {
						throw e;
					}
				}
			}

			done();
		});

		it('Should have an empty builder with a valid connector', function(done) {
			try {
				var bn1 = new builderNode('and');
				var bn2 = new builderNode('or');

				expect(bn1).to.have.property('parent', null);
				expect(bn1).to.have.property('name', 'and');
				expect(bn1.children).to.have.length(0);
				expect(bn2).to.have.property('parent', null);
				expect(bn2).to.have.property('name', 'or');
				expect(bn2.children).to.have.length(0);
			} catch (e) {
				if (e instanceof TelepatError){
					assert.fail(e, undefined, 'Expected builderNode constructor to not throw error: ' + e);
				} else {
					throw e;
				}
			}

			done();
		});

		it('Should throw an error because trying to add invalid filter', function(done) {
			try {
				var bn1 = new builderNode('and');
				bn1.addFilter('qwop');
				assert.fail(undefined, TelepatError, 'Expected buildNode.addFilter to throw error');
			} catch (e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e).to.have.property('code', '048');

				try {
					bn1 = new builderNode('and');
					bn1.addFilter('is');
					assert.fail(undefined, TelepatError, 'Expected buildNode.addFilter to throw error');
				} catch (e1) {
					expect(e1).to.be.instanceof(TelepatError);
					expect(e1).to.have.property('code', '048');
				}

			}

			done();
		});

		it('Should throw an error because trying to add invalid value', function(done) {
			try {
				var bn1 = new builderNode('and');
				bn1.addFilter('is', 'string wut');
				assert.fail(undefined, TelepatError, 'Expected buildNode.addFilter to throw error');
			} catch (e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e).to.have.property('code', '048');

				try {
					bn1 = new builderNode('and');
					bn1.addFilter('range', 'wut');
					assert.fail(undefined, TelepatError, 'Expected buildNode.addFilter to throw error');
				} catch (e1) {
					expect(e1).to.be.instanceof(TelepatError);
					expect(e1).to.have.property('code', '048');
				}

			}

			done();
		});

		it('Should add all supported filters to builder', function(done) {
			try {
				var bn1 = new builderNode('and'),
					filters = [
					{
						is: {field: 'test'}
					},
					{
						not: {is: {field: 'test'}}
					},
					{
						exists: 'field'
					},
					{
						range: {field: {gte: 0, lte: 1}}
					},
					{
						in_array: {field: 'test'}
					},
					{
						like: {field: 'test'}
					}
				];

				filters.forEach(function(f) {
					var name = Object.keys(f)[0];
					bn1.addFilter(name, f[name]);
				});

				expect(bn1.children).to.deep.equal(filters);

			} catch (e) {
				if (e instanceof TelepatError){
					assert.fail(e, undefined, 'Expected builderNode.addFilter to not throw error: ' + e);
				} else {
					throw e;
				}
			}

			done();
		});

		it('Should fail adding a node because argument is not instanceof BuilderNode', function(done) {
			try {
				var bn1 = new builderNode('and');
				bn1.addNode('string');
				assert.fail(undefined, TelepatError, 'Expected builderNode.addNode to throw error');
			} catch (e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e).to.have.property('code', '002');
			}

			done();
		});

		it('Should add a valid builderNode', function(done) {
			try {
				var bn1 = new builderNode('and');
				var bn2 = new builderNode('or');

				bn1.addNode(bn2);

				expect(bn1.children).to.have.length(1);
				expect(bn2.parent).to.be.instanceof(builderNode);
				expect(bn2.parent).to.have.property('name', 'and');
			} catch (e) {
				if (e instanceof TelepatError){
					assert.fail(e, undefined, 'Expected builderNode constructor to not throw error: ' + e);
				} else {
					throw e;
				}
			}

			done();
		});

		it('Should fail removing a node because argument is not instanceof BuilderNode', function(done) {
			try {
				var bn1 = new builderNode('and');
				bn1.removeNode('string');
				assert.fail(undefined, TelepatError, 'Expected builderNode.addNode to throw error');
			} catch (e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e).to.have.property('code', '002');
			}

			done();
		});

		it('Should remove a valid builderNode', function(done) {
			try {
				var bn1 = new builderNode('and');
				var bn2 = new builderNode('or');

				bn1.addNode(bn2);

				var result = bn1.removeNode(bn2);

				expect(bn1.children).to.have.length(0);
				expect(bn2.parent).to.be.equal(null);
				expect(result).to.be.instanceof(builderNode);
				expect(result).to.have.property('name', 'or');
			} catch (e) {
				if (e instanceof TelepatError){
					assert.fail(e, undefined, 'Expected builderNode.removeNode to not throw error: ' + e);
				} else {
					throw e;
				}
			}

			done();
		});

		it('Should return an object representing the node', function(done) {
			try {
				var bn1 = new builderNode('and');

				var result = bn1.toObject();
				expect(result).to.be.deep.equal({and: []});

				//testing a simple node with just 1 filter
				bn1.addFilter('is', {application_id: 1});
				expect(bn1.toObject()).to.be.deep.equal(
					{
						and: [
							{
								is:
									{
										application_id: 1
									}
							}
						]
					}
				);

				//testing a simple node with multiple filters
				bn1.addFilter('range', {age: {gte: 18}});
				expect(bn1.toObject()).to.be.deep.equal(
					{
						and: [
							{
								is: {
										application_id: 1
									}
							},
							{
								range: {
									age: {
										gte: 18
									}
								}
							}
						]
					}
				);

				//testing nested node with multiple filters
				var bn2 = new builderNode('or');
				bn2.addFilter('is', {user_id: 1});
				bn2.addFilter('is', {user_id: 2});
				bn1.addNode(bn2);
				expect(bn1.toObject()).to.be.deep.equal(
					{
						and: [
							{
								is: {
										application_id: 1
									}
							},
							{
								range: {
									age: {
										gte: 18
									}
								}
							},
							{
								or: [
									{
										is: {
											user_id: 1
										}
									},
									{
										is: {
											user_id: 2
										}
									}
								]
							}
						]
					}
				);

				//testing triple nested node with filters
				var bn3 = new builderNode('and');
				bn3.addFilter('is', {field: 'value'});
				bn2.addNode(bn3);
				expect(bn1.toObject()).to.be.deep.equal(
					{
						and: [
							{
								is: {
										application_id: 1
									}
							},
							{
								range: {
									age: {
										gte: 18
									}
								}
							},
							{
								or: [
									{
										is: {
											user_id: 1
										}
									},
									{
										is: {
											user_id: 2
										}
									},
									{
										and: [
											{
												is: {
													field: 'value'
												}
											}
										]
									}
								]
							}
						]
					}
				);

			} catch (e) {
				if (e instanceof TelepatError){
					assert.fail(e, undefined, 'Expected builderNode.toObject to not throw error: ' + e);
				} else {
					throw e;
				}
			}

			done();
		});
	});

	describe('FilterBuilder', function() {
		it('Should construct a FilterBuilder with no initial node supplied', function(done) {
			var fb = new FilterBuilder();

			expect(fb.root).to.be.instanceof(builderNode);
			expect(fb.root).to.have.property('name', 'and');
			expect(fb.root.children).to.have.length(0);
			expect(fb.pointer).to.be.equal(fb.root);

			done();
		});

		it('Should construct a FilterBuilder with initial node', function(done) {
			var fb = new FilterBuilder('or');

			expect(fb.root).to.be.instanceof(builderNode);
			expect(fb.root).to.have.property('name', 'or');
			expect(fb.root.children).to.have.length(0);
			expect(fb.pointer).to.be.equal(fb.root);

			done();
		});

		it('Should add an "and" node', function(done) {
			var fb = new FilterBuilder('or');
			var initialPointer = fb.root;
			var returnValue = fb.and();

			expect(fb.pointer).to.be.not.equal(initialPointer);
			expect(fb.pointer).to.have.property('name', 'and');
			expect(fb.root.children).to.have.length(1);
			expect(fb).to.be.equal(returnValue);

			done();
		});

		it('Should add an "or" node', function(done) {
			var fb = new FilterBuilder('or');
			var initialPointer = fb.root;
			var returnValue = fb.or();

			expect(fb.pointer).to.be.not.equal(initialPointer);
			expect(fb.pointer).to.have.property('name', 'or');
			expect(fb.root.children).to.have.length(1);
			expect(fb).to.be.equal(returnValue);

			done();
		});

		it('Should add filter to the curent pointer', function(done) {
			var fb = new FilterBuilder('or');
			var returnedValue = fb.addFilter('is', {user_id: 1});
			expect(returnedValue).to.be.equal(fb);
			returnedValue.addFilter('is', {user_id: 2});

			expect(fb.root.children).to.have.length(2);
			expect(fb.root.toObject()).to.be.deep.equal({
				or: [
					{
						is: {
							user_id: 1
						}
					},
					{
						is: {
							user_id: 2
						}
					}
				]
			});

			done();
		});

		it('Should return null because root node cannot be removed', function(done) {
			var fb = new FilterBuilder();

			expect(fb.removeNode()).to.be.equal(null);
			expect(fb.root).to.be.equal(fb.pointer);

			done();
		});

		it('Should remove the current pointer node', function(done) {
			var fb = new FilterBuilder();
			fb.and();

			var insertedNode = fb.pointer;

			expect(fb.removeNode()).to.be.equal(insertedNode);
			expect(fb.root).to.be.equal(fb.pointer);

			done();
		});

		it('Should check if the filter builder is empty or not', function(done) {
			var fb = new FilterBuilder();

			expect(fb.isEmpty()).to.be.eql(true);

			fb.and();

			expect(fb.isEmpty()).to.be.eql(false);

			done();
		});

		it('Should end the current pointer and go back to parent', function(done) {
			var fb = new FilterBuilder();

			expect(fb.end()).to.be.equal(fb);

			fb.and();

			var insertedNode = fb.pointer;

			expect(fb.end()).to.be.equal(fb);
			expect(fb.root).to.be.equal(fb.pointer);

			done();
		});

		it('Should when trying to build the query because root is empty ', function(done) {
			try {
				var fb = new FilterBuilder();
				var ret = fb.build();
				assert.fail(ret, undefined, 'FilterBuilder.build should throw error');
			} catch (e) {
				expect(e).to.be.instanceof(TelepatError);
				expect(e).to.have.property('code', '048');
				done();
			}
		});

		it('Should construct the filter object', function(done) {
			var fb = new FilterBuilder();

			fb.addFilter('is', {field: 'value'}).
				addFilter('exists', 'field').
				or().
				addFilter('like', {text: 'something'}).
				addFilter('range', {age: {gte: 18}});

			expect(fb.build()).to.be.deep.equal({
				and: [
					{
						is: {
							field: 'value'
						}
					},
					{
						exists: 'field'
					},
					{
						or: [
							{
								like: {
									text: 'something'
								}
							},
							{
								range: {
									age: {
										gte: 18
									}
								}
							}
						]
					}
				]
			});

			done();
		});
	});
}
