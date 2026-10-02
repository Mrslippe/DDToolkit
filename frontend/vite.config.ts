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
  /**
   * **只有一个入口**（2026-10-03：桌面小窗那条线整体放弃，第二个入口随之删除）。
   *
   * `index.html` → `src/main.tsx` 主窗口（整个应用）。
   *
   * 历史（留着，因为"拆入口"这件事以后还会遇到）：小窗曾经走 `index.html?widget=1`
   * 靠**运行时**判断分流，但**静态 import 拦不住** —— 整个应用（App / react-router /
   * shadcn / ECharts / layout.css）都会被拉进那个 renderer（实测 132MB）。
   * 后来给它开过独立入口 `widget.html` → `src/widgetMain.tsx`，两次都随小窗一起删掉。
   * ⚠️ 哪天真要再拆入口：先自查新入口是否在蹭别处的全局 reset（`box-sizing` / `.os-*` /
   * dev token），否则症状是"独立入口里样式全乱"。
   */
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.html'),
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
