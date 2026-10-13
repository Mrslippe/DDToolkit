/**
 * 录播播放器窗的入口（2026-10-13，用户 3.2）。
 *
 * ## 它为什么是一个独立入口
 *
 * 主窗那套（启动幕 / 路由 / 后端引导 / 消息通道 / 问题上报）播放器一样都不需要，
 * 而**静态 import 拦不住**：只要 `index.html` 里那些 import 还在，整个应用就会被打进
 * 这扇窗口的 renderer（历史小窗实测 132MB，`devlog/274`）。所以这里只做四件事：
 *
 * 1. 从 URL 取 `bvid` / `p`（Rust 侧建窗时拼的，已校验过形状）；
 * 2. **注入后端地址与 token** —— ⚠️ 这扇窗要自己发业务请求（取流/段表都要
 *    `X-DDToolkit-Token`，后端只放行 `/healthz`、`/static/`），所以壳把它放进了
 *    `CALLER_LABELS_ALLOWED`（`lib.rs`）。取不到就如实显示，别静默播不了；
 * 3. 渲染 `BiliVideo`（取流/清晰度/分P/MSE 全是现成的）；
 * 4. 右上角一枚 ✕ → `close_player_window`（无边框窗没有系统标题栏）。
 *
 * ⚠️ 它**不**碰 `installExternalLinkGuard` / `startMessageBus` / 启动幕：那三样都依赖
 * 主窗的那套状态（路由、壳可见性、问题上报的面板），搬过来只会得到一半的初始化。
 * 播放器里唯一的外部动作是"在浏览器打开"—— 那件事由主窗的播放器浮层提供，
 * 这扇窗里没有（所以 `open_external` **没有**进 `PLAYER_COMMAND_ACL`：最小权限面）。
 */
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { X } from 'lucide-react'

import './index.css'
import './styles/tokens.css'
/* ⚠️ `.vp*`（播放器）与 `.bili-*` 的样式都住在 `posts.css` 里，这里必须整份引进来 ——
   不是"图省事"：把它们拆出去要动主窗那份的层叠顺序（`posts.css` 里的规则彼此有覆盖关系）。
   而这一批真正要省的是 **JS**（上面那段历史说的 132MB 是 JS 侧的树）。 */
import './styles/posts.css'

import BiliVideo from './components/BiliVideo'
import { DEV_API_TOKEN, holdApiUntilReady, markNoTokenRequired, markTokenReady, setApiBase, setApiToken } from './api/api'
import { closePlayerWindow } from './utils/shellBridge'

const isTauri = '__TAURI_INTERNALS__' in window

/** 与主窗同一条闸门：token 没注入之前不许发业务请求（否则必然 401） */
holdApiUntilReady()

async function bootstrapApi(): Promise<string | null> {
  if (!isTauri) {
    // 浏览器/探针：拿开发态 token 开闸（与 `main.tsx` 同一口径）
    if (DEV_API_TOKEN) { markTokenReady(); return null }
    markNoTokenRequired()
    return null
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const port = await invoke<number>('get_backend_port')
    const token = await invoke<string>('get_api_token')
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 240; i++) {
      try {
        const r = await fetch(`${base}/healthz`, { cache: 'no-store' })
        if (r.ok) { setApiBase(base); setApiToken(token); return null }
      } catch { /* 后端还没起来，继续等 */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    return '等不到后端服务（看应用日志里的 sidecar 那几行）'
  } catch (e) {
    return `取不到后端地址或会话令牌：${String(e)}`
  }
}

function PlayerApp() {
  const q = new URLSearchParams(window.location.search)
  const bvid = (q.get('bvid') ?? '').trim()
  const page = Number(q.get('p') ?? '') || undefined
  const [err, setErr] = useState<string | null>(null)
  const [ready, setReady] = useState(!isTauri)

  useEffect(() => {
    let alive = true
    void bootstrapApi().then((e) => {
      if (!alive) return
      setErr(e)
      setReady(e === null)
    })
    return () => { alive = false }
  }, [])

  // 无边框窗：Esc 关掉它（与"点 ✕"同一条路）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void closePlayerWindow() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="pwin">
      {/* 无边框窗没有系统标题栏 ⇒ 自己画一条可拖拽的窄条（`data-tauri-drag-region`） */}
      <div className="pwin-bar" data-tauri-drag-region>
        <span className="pwin-title">录播 {bvid || '（没给 BV 号）'}{page ? ` · P${page}` : ''}</span>
        <span className="pwin-spacer" data-tauri-drag-region />
        <button type="button" className="pwin-close" aria-label="关闭播放器"
                data-player-close="1" onClick={() => void closePlayerWindow()}>
          <X className="size-4" />
        </button>
      </div>
      <div className="pwin-body">
        {err && <p className="pwin-err" role="alert">{err}</p>}
        {ready && bvid && <BiliVideo key={bvid} bvid={bvid} initialPage={page} />}
        {ready && !bvid && (
          <p className="pwin-err" role="alert">
            这个窗口是播放器，需要一个 <code>?bvid=BV…</code> 参数（从主窗的录播按钮进来）
          </p>
        )}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('player-root')!).render(
  <React.StrictMode>
    <PlayerApp />
  </React.StrictMode>,
)
