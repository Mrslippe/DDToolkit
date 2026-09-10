// 启动诊断陷阱：未捕获异常 / Promise 拒绝全部记录并常驻显示。
// React 就绪后折叠为右上角徽章待查；支持一键复制全文。
// 修复：此逻辑原为 index.html 内联 <script>，被 Tauri 打包注入的 CSP
// `script-src 'self'` 拦截而静默失效（生产包中诊断面板/右键禁用不生效）；
// 改为外部模块，作为 main.tsx 的首个 import 最先执行。
;(function () {
  const lines: string[] = []
  let open = true
  // 资源级失败计数（2026-09-10 用户反馈：单张图直连抖一下就把红色诊断面板弹出来）
  let resourceErrors = 0

  function log(msg: string, opts?: { quiet?: boolean }) {
    lines.push(
      '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg,
    )
    // [perf] 启动计时行不弹面板（每次启动都弹很打扰）；面板由真实错误触发时
    // 会连同 perf 时间线一起展示。
    // quiet（资源级失败）同样只入日志不弹面板——见下方 error 捕获处的说明。
    if (opts?.quiet || msg.startsWith('[perf]')) return
    render()
  }

  function render() {
    if (!lines.length) return
    let box = document.getElementById('boot-diag')
    if (!box) {
      box = document.createElement('div')
      box.id = 'boot-diag'
      box.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:10000;width:min(560px,92vw);' +
        'font:12px/1.6 Consolas,monospace;border-radius:8px;overflow:hidden;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.35)'
      box.innerHTML =
        '<div id="bd-head" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#7f1d1d;color:#fecaca;cursor:pointer">' +
        '<span id="bd-title">启动诊断</span><span style="flex:1"></span>' +
        '<button id="bd-copy">复制</button>' +
        '<button id="bd-toggle">收起</button></div>' +
        '<pre id="bd-body" style="margin:0;padding:10px;background:#111827;color:#fca5a5;max-height:50vh;overflow:auto;white-space:pre-wrap"></pre>'
      document.body.appendChild(box)
      const q = <T extends HTMLElement>(sel: string) => box!.querySelector(sel) as T
      const st =
        'all:unset;cursor:pointer;padding:1px 10px;border-radius:4px;background:#991b1b;color:#fff;font:inherit'
      q('#bd-copy').style.cssText = st
      q('#bd-toggle').style.cssText = st
      const copyBtn = q('#bd-copy')
      copyBtn.onclick = () => {
        try {
          void navigator.clipboard.writeText(lines.join('\n'))
          copyBtn.textContent = '已复制'
        } catch {
          copyBtn.textContent = '复制失败'
        }
      }
      q('#bd-toggle').onclick = toggle
      q('#bd-head').onclick = toggle
    }
    function toggle() {
      open = !open
      const b = document.getElementById('bd-body')
      if (b) b.style.display = open ? 'block' : 'none'
    }
    document.getElementById('bd-title')!.textContent = '启动诊断 ' + lines.length + ' 条'
    document.getElementById('bd-body')!.textContent = lines.join('\n')
  }

  window.addEventListener('error', function (e) {
    log('[error] ' + (e.message || e.filename || 'unknown'))
  })
  // 捕获阶段：资源加载失败（img/css/js 404 等）不冒泡，只有 capture 能收到；
  // 仅记录仍在 DOM 中的目标——快速切换列表/筛选导致图片「加载中止」时，
  // error 会派发到已卸载的 img 上（isConnected=false），这属于交互噪声而非
  // 真实失败（真实 404 时元素仍挂载；2026-09-03 反馈：快速点类型 chips 误报）。
  //
  // 2026-09-10 用户反馈：单张 B 站动态图（i0.hdslb.com，实测直连 200/1920×1080）
  // 在 WebView 里偶发一次失败，就把「启动诊断」红色面板弹了出来 —— 但这类失败
  // **已经被 ProxyImage 的三级兜底处理**（直连 → /img-proxy → 占位），属于可自愈的
  // 瞬时抖动，不该打断用户。因此资源失败只入日志（copy 时仍能看到），
  // 连续 ≥3 次才视为真实故障（系统性 404/断网）并弹面板。
  window.addEventListener(
    'error',
    function (e) {
      const t = e.target as HTMLElement
      if (t && t !== document.documentElement && t !== document.body && t.isConnected) {
        const src = (t as HTMLImageElement).src || (t as HTMLLinkElement).href
        if (src) {
          resourceErrors += 1
          log('[resource] ' + src, { quiet: true })
          if (resourceErrors >= 3) render()
        }
      }
    },
    true,
  )
  // console.error 钩子：React 内部错误（如渲染崩溃）只走这里，
  // 过滤 React 开发警告保持信号干净
  try {
    const origError = console.error
    console.error = function (...args: unknown[]) {
      const msg = args
        .map((a) => (typeof a === 'string' ? a : (a && (a as Error).message) || String(a)))
        .join(' ')
      if (!msg.startsWith('Warning:')) log('[console.error] ' + msg)
      origError.apply(console, args)
    }
  } catch {
    /* 忽略 */
  }
  window.addEventListener('unhandledrejection', function (e) {
    log('[promise] ' + String(e.reason))
  })
  // 全局禁用浏览器右键菜单（捕获阶段，先于一切渲染生效）
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault()
  }, true)

  window.__bootLog = log
  // React 就绪后不再整版弹出，仅保留徽章待查
  window.__bootFold = function () {
    open = false
    const b = document.getElementById('bd-body')
    if (b) b.style.display = 'none'
    const t = document.getElementById('bd-toggle')
    if (t) t.textContent = '展开'
  }
})()