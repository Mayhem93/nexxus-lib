const tests = [
	require('./constructor'),
	require('./getObjects'),
	require('./createObjects'),
	require('./updateObjects'),
	require('./deleteObjects'),
	require('./getQueryObject')
];

tests.forEach(t => {
	t();
});
