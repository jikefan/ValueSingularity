import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'scripts', 'src/types/openapi.gen.ts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // 组件与 hooks 基本法
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // 类型纪律
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // 异步纪律：不允许丢弃 Promise
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // 命名
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'interface', format: ['PascalCase'] },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'], leadingUnderscore: 'allow' },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
      ],

      // 通用
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: '禁止直接调用 fetch，请统一通过 src/lib/api.ts 发起请求。',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: '不要在组件里写死颜色，用 styles/tokens.css 的 CSS 变量（或 echarts 主题常量）。',
        },
      ],
    },
  },
  {
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tanstack/react-query',
              message: '展示组件不直接发起数据请求，请通过 props 接收数据。',
            },
          ],
          patterns: [
            {
              group: ['**/features', '**/features/**', '**/lib/api', '**/lib/api.*'],
              message: 'components/ 只能依赖 props 与纯工具，禁止反向依赖 features/ 或 lib/api。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features', '**/features/**'],
              message: 'lib/ 禁止依赖 features/，保持单向依赖。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/types/api.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: '不要在组件里写死颜色，用 styles/tokens.css 的 CSS 变量（或 echarts 主题常量）。',
        },
        {
          selector: 'TSInterfaceDeclaration',
          message:
            '禁止在 src/types/api.ts 手写 interface；所有 API 类型必须由 openapi.gen.ts 派生，改后端后请运行 make gen-api。',
        },
      ],
    },
  },
  {
    // 图表颜色字面量的唯一豁免处
    files: ['src/lib/chartTheme.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['src/lib/api.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // 测试文件可以更宽松
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'no-restricted-globals': 'off',
    },
  },
)
