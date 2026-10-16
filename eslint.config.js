import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sevari from './tools/eslint-plugin-sevari/index.js';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'docs/**', 'apps/owner-ui/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    plugins: { sevari },
    rules: {
      'sevari/no-network-outside-egress': 'error',
      'sevari/no-io-in-domain': 'error',
      'sevari/no-raw-date': 'error',
      'sevari/no-raw-sql-outside-db': 'error',
      'sevari/no-grounded-draft-forgery': 'error',
      'sevari/no-reserved-override': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // The owner app runs in the browser (same-origin only, strict CSP).
    files: ['apps/api/public/**/*.js'],
    languageOptions: { globals: { document: 'readonly', sessionStorage: 'readonly', fetch: 'readonly', setInterval: 'readonly' } },
  },
  {
    files: ['**/test/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts', 'eval/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
