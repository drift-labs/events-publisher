module.exports = {
	env: {
		es6: true,
		node: true,
	},
	plugins: ['eslint-plugin-local-rules'],
	rules: {
		'local-rules/sqlclient-no-connection-access': 2,
		'react/react-in-jsx-scope': 0,
	},
};
