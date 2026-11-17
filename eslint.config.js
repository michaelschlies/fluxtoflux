import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: globals.node },
    rules: {
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-shadow': 'error',
      'no-throw-literal': 'error',
      'no-console': 'error',
    },
  },
  {
    // The entry point owns process output; everything else logs through the injected log function.
    files: ['src/index.js', 'test/**'],
    rules: { 'no-console': 'off' },
  },
];
