import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 开发代理：/api → 后端 FastAPI（http://127.0.0.1:8000），路径前缀剥离。
// 生产部署时可用 VITE_API_BASE 指向后端地址直连。
//
// ⚠️ S1 起后端要求会话 token（`app/core/api_auth.py`）；本文件把**开发态固定 token**
// 注入前端（`define` 是编译期替换，所以 shell 的环境变量同样管用），
// 默认值与 `scripts/ui_probe.py` 的 `PROBE_DEV_TOKEN` 必须一致 ——
// 两边不一致的症状是"探针页面所有数据为空 ⇒ 布局断言集体报红"，看起来像布局坏了
// （2026-09-25 真实踩过一次，见 devlog/201 §四）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_DEV_API_TOKEN': JSON.stringify(
      process.env.VITE_DEV_API_TOKEN ?? 'dsh-ui-probe-dev-token',
    ),
  },
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  build: {
    rollupOptions: {
      /**
       * **两个入口**（R38 批 5b，2026-09-24）。
       *
       * `index.html`  → `src/main.tsx`       主窗口（整个应用）
       * `widget.html` → `src/widgetMain.tsx` 桌面状态控件小窗（只有一个胶囊）
       *
       * 为什么要分开：原来小窗走 `index.html?widget=1`，靠 `main.tsx` 里的**运行时**判断分流 ——
       * 但**静态 import 拦不住**，整个应用（App / react-router / shadcn / ECharts / layout.css）
       * 都会被拉进小窗那个 renderer。实测小窗 renderer **132MB**，而 Chromium 基础开销
       * 只占小部分，大头是我们自己的代码与依赖。
       */
      input: {
        main: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.html'),
        widget: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'widget.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
