import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'playwright-report/**', 'test-results/**', 'output/**'],
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        module: 'readonly',
        exifr: 'readonly',
        JSZip: 'readonly',
        WebMMuxer: 'readonly',
        Muxer: 'readonly',
        ArrayBufferTarget: 'readonly',
        L: 'readonly',
        I18N: 'readonly',
        currentLang: 'writable',
        t: 'readonly',
        tf: 'readonly',
        setLang: 'readonly',
        applyTranslations: 'readonly',
        FrameEngine: 'readonly',
        InstaFrameCore: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
  {
    files: ['tests/**/*.{js,cjs,mjs}', 'playwright.config.cjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
