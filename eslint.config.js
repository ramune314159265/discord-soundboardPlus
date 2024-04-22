import eslint from '@eslint/js'
import globals from 'globals'

export default [
	eslint.configs.recommended,
	{
		ignores: ['node_modules', '.env'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.commonjs,
				...globals.es6,
				...globals.node
			},
		},
		rules: {
			"semi": [
				"error",
				"never",
				{
					"beforeStatementContinuationChars": "never"
				}
			],
			"semi-spacing": [
				"error",
				{
					"after": true,
					"before": false
				}
			],
			"semi-style": [
				"error",
				"first"
			],
			"no-extra-semi": "error",
			"no-unexpected-multiline": "error",
			"no-unreachable": "error"
		}
	}
]
