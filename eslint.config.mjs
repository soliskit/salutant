import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import promise from 'eslint-plugin-promise';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  promise.configs['flat/recommended'],
  prettierRecommended,
  {
    // tsconfig.json covers src and scripts with checkJs, so the project
    // service can type them.
    files: ['src/**/*.js', 'scripts/**/*.js'],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.strictTypeChecked
    ],
    languageOptions: {
      parserOptions: { projectService: true }
    }
  },
  {
    // JS files no tsconfig covers get untyped rules only.
    files: ['tests/**/*.js', 'tests/**/*.mjs', '*.mjs'],
    extends: [tseslint.configs.disableTypeChecked]
  },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.serviceworker }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    }
  },
  {
    files: [
      'tests/browser-protocol.test.js',
      'tests/measurement/fixtures/**/*.mjs'
    ],
    languageOptions: {
      globals: { ...globals.browser }
    }
  }
);
