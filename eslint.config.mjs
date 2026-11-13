import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'out/', 'coverage/', '.vscode-test/']),
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MetaProperty[meta.name='import']",
          message: 'import.meta does not exist in the CommonJS and IIFE bundles.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
