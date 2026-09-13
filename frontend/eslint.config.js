/**
 * ESLint 配置（2026-09-13 落地，`FRONTEND-ARCH.md` §5 P3 的另一半）。
 *
 * ## 为什么是这套规则，而不是 `eslint:recommended` 全家桶
 *
 * 本项目的代码风格已经稳定（`FRONTEND-ARCH.md` §1.4：`!important` 0 处、
 * 依赖全部在用、选择器按 feature 前缀分区），**风格类规则加进来只会制造噪音**。
 * 真正反复咬人的是**行为类问题**，所以只开这几条：
 *
 * 1. `react-hooks/exhaustive-deps`（warn）—— 这是本项目的历史病灶：
 *    P6-1 回顶 effect 漏 `accountKey`、051 弹窗草稿被后台刷新冲掉、
 *    A-2 拆分时 `onDataRefresh` 该不该进依赖。**靠人眼必然漏。**
 *    定为 warn 而非 error：仓库里有多处**故意**的依赖省略（都带
 *    `eslint-disable-next-line` 与理由注释），warn 让新引入的漏项显眼、
 *    又不至于让 `npm run lint` 常年红着（`test_version_synced_with_devlog`
 *    曾长期红着就是"红了就没人看"的教训）。
 * 2. `react-hooks/rules-of-hooks`（error）—— hooks 调用顺序是硬约束，
 *    违反即崩溃（A-2 拆分时差点踩 TDZ）。
 * 3. `@typescript-eslint/no-unused-vars`（warn）—— 拆巨件后最容易留下的垃圾
 *    （A-3 拆 `LiveSessionDialog` 后 `tsc` 抓到 7 个未使用导入）。
 *    `_` 前缀与 rest 兄弟豁免，沿用项目既有约定（`_acc` / `_vtuber`）。
 * 4. `no-debugger` / `no-constant-binary-expression` / `no-unreachable`（error）——
 *    零误报的真 bug 类规则。
 *
 * **刻意不开**：`no-explicit-any`（项目有少量必要的 `as never`/`as any`）、
 * 格式化类规则（交给 prettier，且本批不引入 prettier 以免一次性产生几百行 diff）、
 * `react-refresh/only-export-components`（`components/ui/*` 与 `common/*`
 * 大量同文件导出常量，属于既有结构）。
 *
 * 用法：`npm run lint`（`--max-warnings` 不设，先看全量再逐步收敛）。
 */
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/**',
      'public/**',
      '*.config.js',
      'vite.config.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        ResizeObserver: 'readonly', IntersectionObserver: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
        HTMLElement: 'readonly', HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly', HTMLInputElement: 'readonly',
        HTMLSpanElement: 'readonly', Element: 'readonly', Node: 'readonly',
        Event: 'readonly', CustomEvent: 'readonly', KeyboardEvent: 'readonly',
        MouseEvent: 'readonly', PointerEvent: 'readonly', Error: 'readonly',
        Map: 'readonly', Set: 'readonly', Math: 'readonly', JSON: 'readonly',
        Date: 'readonly', Number: 'readonly', String: 'readonly',
        Object: 'readonly', Array: 'readonly', Boolean: 'readonly',
        Promise: 'readonly', RegExp: 'readonly', Intl: 'readonly',
        localStorage: 'readonly', performance: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      // ① 本项目的历史病灶：依赖数组漏项（见文件头注释）
      'react-hooks/exhaustive-deps': 'warn',
      // ② hooks 调用顺序是硬约束
      'react-hooks/rules-of-hooks': 'error',
      // ③ 拆巨件后最容易留下的垃圾（用 TS 版，base 版不认类型标注）
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // ④ 零误报的真 bug 类
      'no-debugger': 'error',
      'no-constant-binary-expression': 'error',
      'no-unreachable': 'error',
      // ⑤ TS 已经管了、重复报只会噪音的
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]
