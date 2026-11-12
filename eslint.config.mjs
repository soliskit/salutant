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
    files: [
      'src/**/*.js',
      'scripts/**/*.js',
      'tests/measurement/v8merge.mjs',
      'tests/measurement/validate.mjs',
      'tests/measurement/checks.mjs',
      'tests/measurement/filelists.mjs',
      'tests/headers.test.js',
      'tests/logging-hygiene.test.js',
      'tests/signing-key-jwk.test.js',
      'tests/measurement/provision.mjs',
      'tests/browser-protocol.test.js',
      'tests/defaults-and-restore.test.js',
      'tests/do-stored-boundaries.test.js',
      'tests/entry-wiring.test.js',
      'tests/failure-modes.test.js',
      'tests/helpers.js',
      'tests/lifecycle.test.js',
      'tests/limits.test.js',
      'tests/mail-resend.test.js',
      'tests/measurement/browser-preload.mjs',
      'tests/measurement/convert.mjs',
      'tests/measurement/fixtures/run-fixtures.mjs',
      'tests/measurement/run.mjs',
      'tests/no-hints.test.js',
      'tests/proof-exchange.test.js',
      'tests/resend-cooldown-idempotency.test.js',
      'tests/restore-epoch.test.js',
      'tests/service-stored-boundaries.test.js',
      'tests/sign-in-guards.test.js',
      'tests/sign-in-page.test.js',
      'tests/store-parity.test.js',
      'tests/stub-stored-boundaries.test.js',
      'tests/code-generation.test.js',
      'tests/mock-error-boundaries.test.js',
      'tests/entry-json-boundaries.test.js'
    ],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked
    ].map((config) => ({
      ...config,
      files: [
        'src/**/*.js',
        'scripts/**/*.js',
        'tests/measurement/v8merge.mjs',
        'tests/measurement/validate.mjs',
        'tests/measurement/checks.mjs',
        'tests/measurement/filelists.mjs',
        'tests/headers.test.js',
        'tests/logging-hygiene.test.js',
        'tests/signing-key-jwk.test.js',
        'tests/measurement/provision.mjs',
        'tests/browser-protocol.test.js',
        'tests/defaults-and-restore.test.js',
        'tests/do-stored-boundaries.test.js',
        'tests/entry-wiring.test.js',
        'tests/failure-modes.test.js',
        'tests/helpers.js',
        'tests/lifecycle.test.js',
        'tests/limits.test.js',
        'tests/mail-resend.test.js',
        'tests/measurement/browser-preload.mjs',
        'tests/measurement/convert.mjs',
        'tests/measurement/fixtures/run-fixtures.mjs',
        'tests/measurement/run.mjs',
        'tests/no-hints.test.js',
        'tests/proof-exchange.test.js',
        'tests/resend-cooldown-idempotency.test.js',
        'tests/restore-epoch.test.js',
        'tests/service-stored-boundaries.test.js',
        'tests/sign-in-guards.test.js',
        'tests/sign-in-page.test.js',
        'tests/store-parity.test.js',
        'tests/stub-stored-boundaries.test.js',
        'tests/code-generation.test.js',
        'tests/mock-error-boundaries.test.js',
        'tests/entry-json-boundaries.test.js'
      ]
    })),
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.all.json'],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    // JS files no tsconfig covers get untyped rules only.
    files: ['tests/**/*.js', 'tests/**/*.mjs', '*.mjs'],
    ignores: [
      'tests/measurement/v8merge.mjs',
      'tests/measurement/validate.mjs',
      'tests/measurement/checks.mjs',
      'tests/measurement/filelists.mjs',
      'tests/headers.test.js',
      'tests/logging-hygiene.test.js',
      'tests/signing-key-jwk.test.js',
      'tests/measurement/provision.mjs',
      'tests/browser-protocol.test.js',
      'tests/defaults-and-restore.test.js',
      'tests/do-stored-boundaries.test.js',
      'tests/entry-wiring.test.js',
      'tests/failure-modes.test.js',
      'tests/helpers.js',
      'tests/lifecycle.test.js',
      'tests/limits.test.js',
      'tests/mail-resend.test.js',
      'tests/measurement/browser-preload.mjs',
      'tests/measurement/convert.mjs',
      'tests/measurement/fixtures/run-fixtures.mjs',
      'tests/measurement/run.mjs',
      'tests/no-hints.test.js',
      'tests/proof-exchange.test.js',
      'tests/resend-cooldown-idempotency.test.js',
      'tests/restore-epoch.test.js',
      'tests/service-stored-boundaries.test.js',
      'tests/sign-in-guards.test.js',
      'tests/sign-in-page.test.js',
      'tests/store-parity.test.js',
      'tests/stub-stored-boundaries.test.js',
      'tests/code-generation.test.js',
      'tests/mock-error-boundaries.test.js',
      'tests/entry-json-boundaries.test.js'
    ],
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
