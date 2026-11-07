import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import promise from 'eslint-plugin-promise'
import prettierRecommended from 'eslint-plugin-prettier/recommended'

export default tseslint.config(
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  promise.configs['flat/recommended'],
  prettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.serviceworker }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    }
  },
  {
    files: ['tests/browser-protocol.test.js', 'tests/measurement/fixtures/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  }
)
