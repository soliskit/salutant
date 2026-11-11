import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import promise from 'eslint-plugin-promise';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default defineConfig(
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  promise.configs['flat/recommended'],
  prettierRecommended,
  {
    // tsconfig.json covers src and scripts with checkJs, so the project
    // service can type them.
    files: ['src/**/*.js', 'scripts/**/*.js', 'tests/measurement/v8merge.mjs'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked
    ].map((config) => ({
      ...config,
      files: ['src/**/*.js', 'scripts/**/*.js', 'tests/measurement/v8merge.mjs']
    })),
    languageOptions: {
      parserOptions: { projectService: true }
    }
  },
  {
    // JS files no tsconfig covers get untyped rules only.
    files: ['tests/**/*.js', 'tests/**/*.mjs', '*.mjs'],
    ignores: ['tests/measurement/v8merge.mjs'],
    extends: [tseslint.configs.disableTypeChecked].map((config) => ({
      ...config,
      files: ['tests/**/*.js', 'tests/**/*.mjs', '*.mjs']
    }))
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
