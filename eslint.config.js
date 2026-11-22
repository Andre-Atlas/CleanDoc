import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'dist-cf', '.wrangler', 'node_modules', 'public', 'ml', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Requisito: nada persistido no navegador.
      'no-restricted-globals': ['error',
        { name: 'localStorage', message: 'Proibido: o Doc Cleaner não persiste dados.' },
        { name: 'sessionStorage', message: 'Proibido: o Doc Cleaner não persiste dados.' },
        { name: 'indexedDB', message: 'Proibido: o Doc Cleaner não persiste dados.' },
      ],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'localStorage' },
        { object: 'window', property: 'sessionStorage' },
        { object: 'window', property: 'indexedDB' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  { files: ['src/**/*.test.{ts,tsx}', 'e2e/**'], rules: { 'no-restricted-globals': 'off' } },
);
