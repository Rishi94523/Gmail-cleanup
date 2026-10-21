import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['web/**', 'node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node }
  },
  // Playwright QA scripts also run callbacks inside the page.
  { files: ['public/**/*.js', 'scripts/qa-*.mjs'], languageOptions: { globals: globals.browser } },
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { ignoreRestSiblings: true }]
    }
  }
];
