// 启动期错误陷阱（原「启动诊断」红色面板，2026-10-02 改造，devlog/279）。
//
// 这里只负责**捕获**：未捕获异常 / Promise 拒绝 / console.error / 资源加载失败。
// 判定 → 去重 → 脱敏 → 生成报告在 `utils/problemReport.ts`，呈现由 `ProblemPanel`
// （React，右下角、不遮挡）负责 —— 用户原话：「把这个报错 log 改造成面向用户的报错日志展示，
// 当出现类似的报错就出现，让普通用户更容易提交 bug」。
//
// 历史（为什么这段代码的形状这么怪）：
// - 原为 index.html 内联 <script>，被 Tauri 打包注入的 CSP `script-src 'self'` 拦截而静默失效
//   ⇒ 改为外部模块，作为 main.tsx 的首个 import 最先执行；
// - 资源级失败只入账不弹面板（单张图抖一下不代表系统坏了，且有 ProxyImage 三级兜底）；
// - `[perf]` 启动计时行同样不弹（每次启动都弹很打扰）。
import { reportFromBootLine, reportUserError } from './utils/problemReport'

;(function () {
  const lines: string[] = []
  let resourceErrors = 0

  function log(msg: string, opts?: { quiet?: boolean }) {
    lines.push(
      '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg,
    )
    // 转发给问题报告：`[perf]` 与 quiet（资源抖动）只留在启动时间线里，不惊动用户
    if (opts?.quiet || msg.startsWith('[perf]')) return
    // 行首的时间戳去掉再解析（`reportFromBootLine` 认的是 `[error] …` 形状）
    reportFromBootLine(msg.replace(/^\[[^\]]*\]\s*/, ''))
  }

  window.addEventListener('error', function (e) {
    log('[error] ' + (e.message || e.filename || 'unknown'))
  })
  // 捕获阶段：资源加载失败（img/css/js 404 等）不冒泡，只有 capture 能收到；
  // 仅记录仍在 DOM 中的目标——快速切换列表/筛选导致图片「加载中止」时，
  // error 会派发到已卸载的 img 上（isConnected=false），这属于交互噪声而非
  // 真实失败（真实 404 时元素仍挂载；2026-09-03 反馈：快速点类型 chips 误报）。
  //
  // 2026-09-10 用户反馈：单张 B 站动态图在 WebView 里偶发一次失败就弹红色面板，
  // 而这类失败**已经被 ProxyImage 的三级兜底处理**（直连 → /img-proxy → 占位）。
  // 因此资源失败只入账；连续 ≥3 次才视为真实故障（系统性 404/断网）。
  window.addEventListener(
    'error',
    function (e) {
      const t = e.target as HTMLElement
      if (t && t !== document.documentElement && t !== document.body && t.isConnected) {
        const src = (t as HTMLImageElement).src || (t as HTMLLinkElement).href
        if (src) {
          resourceErrors += 1
          const quiet = resourceErrors < 3
          log('[resource] ' + src, { quiet })
          if (!quiet) {
            // ≥3 次：当作真实故障报一条（此前已经记过的噪声不再重复计入）
            reportUserError('资源加载', `${src}（连续 ${resourceErrors} 次失败）`,
                            { kind: 'resource' })
          }
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
  /** 启动时间线的原始行（问题报告据此附上"启动到出错之间发生了什么"） */
  window.__bootTrail = () => lines.slice()
  /**
   * 兼容 R12a 以来的调用方（`main.tsx` 在 React 就绪后调一次）：
   * 新面板**默认就是收起的**，这里只广播一次"可以收起了"。
   */
  window.__bootFold = function () {
    window.dispatchEvent(new Event('ddtoolkit:fold-problem-panel'))
  }
})()
