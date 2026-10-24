import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'dist-eval/', 'eval/.cache/'] },
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
);
