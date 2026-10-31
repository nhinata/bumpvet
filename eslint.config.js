import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'dist-eval/', 'eval/.cache/', 'coverage/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Catches defensive code that the types say is unreachable, which usually
      // means the types trust outside data (registry JSON, lockfiles) too much.
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
  {
    // Shared definitions (CONTRIBUTING.md, Writing code).
    files: ['src/types/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ regex: '^(?!\\./[^/]+$)', message: 'src/types/ imports only from itself.' }],
        },
      ],
      'no-restricted-syntax': ['error', 'ImportExpression', 'TSImportType'],
    },
  },
);
