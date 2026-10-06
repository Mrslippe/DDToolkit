import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react'
import QRCode from 'react-qr-code'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '../api/api'
import type { AuthStatus, AuthPlatform, PairingInfo, QrStartResult } from '../api/types'
import { refreshCapabilities } from '../hooks/useCapabilities'
import { LOGIN_TABS, cookieLoginSpec, loginMode } from '../utils/platformLogin'
import { relTime } from '../utils/noticeBoard'
import { extensionDir, openExtensionDir } from '../utils/shellBridge'

type Platform = AuthPlatform

const PLATFORM_NAME: Record<Platform, string> = Object.fromEntries(
  LOGIN_TABS.map((t) => [t.platform, t.label]),
) as Record<Platform, string>

type Phase = 'generating' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 账号登录浮窗：**两种方式共用一套壳**（第 4 阶段 ④ 第三刀-4，devlog/235）。
 *
 * - **扫码**（B 站 / 微博）：生成二维码 → 2s 轮询（waiting/scanned/confirmed/expired/failed）
 *   → confirmed 时后端已完成取 cookie 并持久化到 `.env`；
 * - **粘贴 cookie**（小红书）：它连二维码接口都要签名（鸡生蛋，见 `services/xhs_auth.py`），
 *   所以在浏览器里登录后把 Cookie 整条粘进来 —— 缺 `a1` 时后端 400 且**不落盘**，
 *   报错文案原样显示在这里。
 *
 * Tab 清单来自 `utils/platformLogin.ts`（单一事实来源）：硬编码平台数组正是"加了平台
 * 但这里没有入口"的来源。
 */
export default function LoginDialog({ open, onOpenChange }: Props) {
  const [platform, setPlatform] = useState<Platform>('bilibili')
  // Tab 清单是单一事实来源 ⇒ 状态表也从它派生（写死三家的那次，加平台就得回来改这里）
  const emptyStatuses = () =>
    Object.fromEntries(LOGIN_TABS.map((t) => [t.platform, null])) as
      Record<Platform, AuthStatus | null>
  const [statuses, setStatuses] = useState<Record<Platform, AuthStatus | null>>(emptyStatuses)
  const [qr, setQr] = useState<QrStartResult | null>(null)
  const [phase, setPhase] = useState<Phase>('generating')
  const [detail, setDetail] = useState('')
  /** 粘贴型平台（小红书 / 抖音）：粘贴框内容 / 保存中 / 保存失败的原文 / 「重新粘贴」是否展开 */
  const [cookie, setCookie] = useState('')
  /** 抖音：UA（签名会把它算进去 —— 与 cookie 必须同源） */
  const [userAgent, setUserAgent] = useState('')
  const [saving, setSaving] = useState(false)
  const [cookieErr, setCookieErr] = useState('')
  const [pasting, setPasting] = useState(false)
  const genSeq = useRef(0)

  // ── 浏览器扩展（E3，2026-10-06）─────────────────────────────────────────
  // 用户口径：一键同步四个平台 cookie 的扩展，配一次长期有效。这一栏是它的**应用侧入口**：
  // 显示配对 token（默认打码）+「复制」+「重置配对」+「上次同步」（自证扩展真的说过话）。
  // ⚠️ token 是凭据：**默认打码**、只有点「显示」才进 DOM 文本；复制走剪贴板。
  const [ext, setExt] = useState<PairingInfo | null>(null)
  const [extShown, setExtShown] = useState(false)
  const [extCopied, setExtCopied] = useState(false)
  const [extConfirmReset, setExtConfirmReset] = useState(false)
  const [extBusy, setExtBusy] = useState(false)
  // 扩展目录（E5，2026-10-06）：装完就在程序目录里（构建期打进产物），这里把路径摆出来。
  // 浏览器/探针环境拿到 null ⇒ 只显示一句说明（见渲染处），不给一个点了没反应的按钮。
  const [extDir, setExtDir] = useState<string | null>(null)
  const [extDirBusy, setExtDirBusy] = useState(false)

  // 打开时加载各平台登录态
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async (p: Platform) => {
      try {
        const s = await api.authStatus(p)
        if (cancelled) return
        setStatuses((prev) => ({ ...prev, [p]: s }))
        if (p === platform && s.logged_in && !s.needs_login) {
          setQr(null)
          setPhase('confirmed')
        }
      } catch {
        // 后端不可达：按未登录处理，让自动 start 把真实错误展示出来
        if (!cancelled) {
          setStatuses((prev) => ({
            ...prev,
            [p]: { logged_in: false, needs_login: true, uid: null, name: null },
          }))
        }
      }
    }
    for (const t of LOGIN_TABS) void load(t.platform)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 取配对信息（打开浮窗时一次）。失败**不弹错**：那一栏显示"读不到"即可 ——
   *  它是"顺便看一眼"的信息，不该拦住登录这件事本身。 */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setExtShown(false)
    setExtCopied(false)
    setExtConfirmReset(false)
    void api.getPairing()
      .then((info) => { if (!cancelled) setExt(info) })
      .catch(() => { if (!cancelled) setExt(null) })
    // 扩展目录同理：这是"告诉你扩展在哪儿"的顺手信息（拿不到就说拿不到，不拦登录）。
    void extensionDir().then((d) => { if (!cancelled) setExtDir(d) })
    return () => { cancelled = true }
  }, [open])

  /** 在资源管理器里打开扩展目录（路径由 Rust 侧解析）。 */
  const openExtDir = async () => {
    setExtDirBusy(true)
    try {
      setExtDir(await openExtensionDir())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setExtDirBusy(false)
    }
  }

  const copyToken = async () => {
    if (!ext?.token) return
    try {
      await navigator.clipboard.writeText(ext.token)
      setExtCopied(true)
      window.setTimeout(() => setExtCopied(false), 1500)
    } catch {
      // 剪贴板被拒（无权限 / 非安全上下文）：**把 token 显示出来**让用户手抄，
      // 比"点了没反应"好。不弹 toast 是因为这一栏本来就看得见。
      setExtShown(true)
    }
  }

  const resetToken = async () => {
    setExtBusy(true)
    try {
      const info = await api.resetPairing()
      setExt(info)
      setExtConfirmReset(false)
      setExtShown(true)          // 刚换的这把要看得见（用户得去扩展里重贴）
      toast.success('配对 token 已重置 —— 扩展那边要重新贴一次')
    } catch (e) {
      toast.error(`重置失败：${(e as Error).message}`)
    } finally {
      setExtBusy(false)
    }
  }

  const start = async (p: Platform) => {
    // 防呆：粘贴型平台没有二维码可生成（调用点包括「重新登录」）
    if (loginMode(p) !== 'qr') return
    const seq = ++genSeq.current
    setPhase('generating')
    setQr(null)
    setDetail('')
    try {
      const r = await api.startQrLogin(p)
      if (genSeq.current !== seq) return
      setQr(r)
      setPhase('waiting')
    } catch (e) {
      if (genSeq.current !== seq) return
      setPhase('failed')
      setDetail((e as Error).message)
    }
  }

  /** 保存粘贴型平台的凭据；成功后用后端返回的登录态刷新本 Tab（不再多发一次 status）
   *
   *  ⚠️ 抖音多一个 UA：它会被算进签名（`a_bogus` 的第三个摘要），而填错的样子是**静默空数据**
   *     ⇒ 一起存，别让它躺在默认值里（devlog/334）。 */
  const saveCookie = async () => {
    const text = cookie.trim()
    if (!text || saving) return
    setSaving(true)
    setCookieErr('')
    try {
      const s = platform === 'douyin'
        ? await api.saveDouyinCookie(text, userAgent.trim())
        : await api.saveXhsCookie(text)
      setStatuses((prev) => ({ ...prev, [platform]: s }))
      setCookie('')
      setUserAgent('')
      setPasting(false)
      // ⚠️ 能力矩阵**要立刻重取**（devlog/338）：登录态变了而顶栏那个「N 项受限」不刷新的话，
      // 用户刚粘完 Cookie 还看到"需要登录"，会以为没生效 —— 与扫码那条路同一个理由
      // （见 `hooks/useCapabilities.ts` 的设计取舍）。
      refreshCapabilities()
      toast.success(`${LOGIN_TABS.find((t) => t.platform === platform)?.label ?? ''} cookie 已保存`)
    } catch (e) {
      // 400 的 detail 直接可显示（"cookie 缺少 a1 —— …"），别吞成"保存失败"
      setCookieErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // 打开 / 切 Tab：等该平台登录态加载完成；未登录才自动生成二维码。
  // 依赖 statuses[platform]：避免状态未加载完就对已登录平台误发二维码请求
  // （B 站 / 微博在刚打开对话框时都会白白 start 一次，日志表现为 qrcode 双请求）。
  useEffect(() => {
    if (!open) {
      setQr(null)
      setPhase('generating')
      return
    }
    if (loginMode(platform) !== 'qr') return // 小红书：粘贴框，不生成二维码
    const s = statuses[platform]
    if (s === null) return // 登录态加载中，等 load() 完成后再决定
    if (s.logged_in && !s.needs_login) {
      setQr(null)
      setPhase('confirmed')
      setDetail('')
      return
    }
    void start(platform)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform, statuses[platform]])

  // 轮询扫码状态
  useEffect(() => {
    if (!open || !qr) return
    let cancelled = false
    const tick = async () => {
      try {
        const r = await api.checkQrLogin(platform, qr.qr_id)
        if (cancelled) return
        if (r.status === 'waiting' || r.status === 'scanned') {
          setPhase(r.status)
        } else if (r.status === 'confirmed') {
          window.clearInterval(timer)
          setPhase('confirmed')
          setDetail(r.detail ?? '')
          toast.success(`${PLATFORM_NAME[platform]}登录成功`)
          api
            .authStatus(platform)
            .then((s) => setStatuses((prev) => ({ ...prev, [platform]: s })))
            .catch(() => {})
        } else if (r.status === 'expired') {
          window.clearInterval(timer)
          setPhase('expired')
        } else {
          window.clearInterval(timer)
          setPhase('failed')
          setDetail(r.detail ?? '登录失败')
        }
      } catch (e) {
        if (!cancelled) {
          window.clearInterval(timer)
          setPhase('failed')
          setDetail((e as Error).message)
        }
      }
    }
    const timer = window.setInterval(tick, 2000)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, qr, platform])

  const cur = statuses[platform]
  // 「已登录」面板只在明确 confirmed 时显示：statuses 缓存可能滞后
  // （如微博 Cookie 过期但旧值仍在），若用 cur.logged_in 判定，点了「重新登录」
  // 后二维码会被「已登录」分支挡住——后端 QR 已在生成，界面上却始终看不到码（2026-09 修复）。
  const showLoggedIn = phase === 'confirmed'
  /** 当前 Tab 是不是「粘贴 cookie」那一路（小红书 / 抖音） */
  const isCookie = loginMode(platform) === 'cookie'
  /** 该平台的粘贴文案与输入框（抖音多一个 UA 框） */
  const spec = cookieLoginSpec(platform)
  /** 粘贴型平台：没配过、或点了「重新粘贴」时展开输入框 */
  const showPasteBox = !cur?.logged_in || pasting
  const readyToSave = Boolean(cookie.trim()) && (!spec.ua || Boolean(userAgent.trim()))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>账号登录</DialogTitle>
          <DialogDescription>
            登录仅用于抓取平台公开数据，可以跳过。B 站 / 微博扫码；
            小红书在浏览器里登录后把 Cookie 粘进来。
          </DialogDescription>
        </DialogHeader>

        {/* 本地存储说明（用户 2026-09-08）：把「凭据只在本机」讲清楚，
            避免用户以为要交出账号密码或担心上传 */}
        <p className="rounded-lg bg-[var(--sel-bg-hover)] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          账号凭据（Cookie）<b className="font-medium text-foreground">仅保存在本机</b>
          数据目录的 <code className="rounded bg-background/70 px-1">.env</code> 文件中，
          不会上传到任何服务器；本应用也<b className="font-medium text-foreground">不接触账号密码</b>。
          想退出登录时，删除该文件即可。
        </p>

        <div className="flex gap-2">
          {LOGIN_TABS.map((t) => (
            <button
              key={t.platform}
              type="button"
              data-auth-tab={t.platform}
              className={`flex-1 rounded-lg border py-1.5 text-sm transition-colors ${
                platform === t.platform
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border text-muted-foreground hover:bg-[var(--sel-bg-hover)]'
              }`}
              onClick={() => {
                setPlatform(t.platform)
                // 换 Tab 时收掉上一个平台的粘贴态（不然切回来会"莫名其妙开着输入框"）
                setPasting(false)
                setCookieErr('')
              }}
            >
              {t.label}
              {statuses[t.platform]?.logged_in && (t.mode === 'cookie' ? ' · 已配置' : ' · 已登录')}
            </button>
          ))}
        </div>

        <div className="flex min-h-[228px] flex-col items-center justify-center gap-3">
          {isCookie ? (
            showPasteBox ? (
              <div className="flex w-full flex-col gap-2">
                <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
                  {spec.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <textarea
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  placeholder={spec.placeholder}
                  className="w-full resize-none border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                {spec.ua && (
                  <>
                    <label className="text-xs font-medium text-muted-foreground">
                      {spec.ua.label}
                    </label>
                    <textarea
                      value={userAgent}
                      onChange={(e) => setUserAgent(e.target.value)}
                      rows={2}
                      spellCheck={false}
                      placeholder={spec.ua.placeholder}
                      data-douyin-ua="1"
                      className="w-full resize-none border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {spec.ua.hint}
                    </p>
                  </>
                )}
                {(cookieErr || cur?.note) && (
                  <p className="text-xs leading-relaxed text-red-500" data-xhs-cookie-error="1">
                    {cookieErr || cur?.note}
                  </p>
                )}
                <button
                  type="button"
                  disabled={!readyToSave || saving}
                  onClick={() => void saveCookie()}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-sm text-muted-foreground transition-colors hover:bg-[var(--sel-bg-hover)] disabled:opacity-50"
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  保存
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center">
                <p className="text-sm font-medium text-green-600">已配置</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {spec.savedNote}
                </p>
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                  onClick={() => {
                    setPasting(true)
                    setCookieErr('')
                  }}
                >
                  <RefreshCw className="size-3.5" /> 重新粘贴
                </button>
              </div>
            )
          ) : showLoggedIn ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="text-sm font-medium text-green-600">已登录</p>
              <p className="text-xs text-muted-foreground">
                {cur?.name || cur?.uid || '凭据有效'}
              </p>
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                onClick={() => void start(platform)}
              >
                <RefreshCw className="size-3.5" /> 重新登录
              </button>
            </div>
          ) : (
            <>
              {phase === 'generating' ? (
                <Loader2 className="size-6 animate-spin text-primary" />
              ) : qr?.url ? (
                <div className="bg-white p-3">
                  <QRCode value={qr.url} size={180} />
                </div>
              ) : qr?.image ? (
                <img src={qr.image} alt="扫码登录" className="size-[180px]" />
              ) : null}
              <p className="text-xs text-muted-foreground">
                {phase === 'waiting' && `请使用手机 App 扫描二维码（${PLATFORM_NAME[platform]}）`}
                {phase === 'scanned' && '已扫码，请在手机上点击确认登录'}
                {phase === 'expired' && '二维码已过期'}
                {phase === 'failed' && (detail || '操作失败')}
              </p>
              {(phase === 'expired' || phase === 'failed') && (
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-[var(--sel-bg-hover)]"
                  onClick={() => void start(platform)}
                >
                  <RefreshCw className="size-3.5" /> 刷新二维码
                </button>
              )}
            </>
          )}
        </div>

        {/* ── 浏览器扩展（E3）：一键同步四个平台 cookie ──────────────────────
            这是扩展的**应用侧入口**：配对 token（默认打码）+ 复制 + 重置 + 上次同步。
            ⚠️ 三条口径：
              · token 默认**打码**（凭据不该一开窗就摊在屏幕上），点「显示」才进 DOM；
              · 「重置配对」要**二次确认**（点错了扩展当场失效，用户得回去重贴）；
              · 「上次同步」只显示**键名与时间**（后端不落值，这里也没有值可显示）。 */}
        <div className="rounded-lg border border-border px-3 py-2 text-xs" data-ext-pairing="1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">浏览器扩展</span>
            {ext?.last_sync ? (
              <span className="text-[11px] text-muted-foreground" data-ext-last-sync={ext.last_sync.platform}>
                上次同步：{ext.last_sync.label} · {relTime(ext.last_sync.at, Date.now()) || '刚刚'}
                {ext.last_sync.verified ? '' : '（未在线验证）'}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">还没有同步过</span>
            )}
          </div>

          {/* 扩展目录（E5，2026-10-06）：装完就在程序目录里（构建期把 `extension/` 打进产物）
              —— 直装版 `<安装目录>\extension\`、便携版 `DDtoolkit\extension\`。
              为什么摆在这里：浏览器只认"商店"或"本地目录 + 开发人员模式"两种来源，应用没法
              替用户装；把路径 + 一个「打开目录」显示出来，新用户就不必去 clone 仓库。
              ⚠️ 浏览器/探针环境拿不到路径（`extensionDir()` 返回 null）⇒ 只显示一句说明，
              不显示一个点了没反应的按钮（探针按 `data-ext-dir` 断言这一行在不在）。 */}
          <div
            className="mt-1.5 rounded border border-border/70 px-1.5 py-1"
            data-ext-dir={extDir ? 'path' : 'unknown'}
          >
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-[11px] text-muted-foreground">扩展目录</span>
              <code
                data-ext-dir-path={extDir ? '1' : '0'}
                title={extDir ?? undefined}
                className="min-w-0 flex-1 truncate rounded bg-[var(--sel-bg-hover)] px-1.5 py-1 font-mono text-[11px]"
              >
                {extDir ?? '随应用一起安装：程序目录里的 extension\\ 子目录'}
              </code>
              {extDir && (
                <button
                  type="button"
                  data-ext-open-dir="1"
                  disabled={extDirBusy}
                  className="shrink-0 rounded border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-[var(--sel-bg-hover)] disabled:opacity-50"
                  onClick={() => void openExtDir()}
                >
                  打开目录
                </button>
              )}
            </div>
            <p className="mt-1 leading-relaxed text-[11px] text-muted-foreground">
              装法：浏览器打开 <code className="rounded bg-background/70 px-1">edge://extensions</code>
              （Chrome 是 <code className="rounded bg-background/70 px-1">chrome://extensions</code>）→
              打开「开发人员模式」→「加载解压缩的扩展」→ 选上面这个目录 → 把下面的 token 贴进扩展设置。
            </p>
          </div>

          {ext?.token ? (
            <>
              <div className="mt-1.5 flex items-center gap-1.5">
                <code
                  data-ext-token={extShown ? 'shown' : 'masked'}
                  className="min-w-0 flex-1 truncate rounded bg-[var(--sel-bg-hover)] px-1.5 py-1 font-mono text-[11px]"
                >
                  {extShown ? ext.token : '•'.repeat(Math.min(ext.token.length, 32))}
                </code>
                <button
                  type="button"
                  data-ext-toggle="1"
                  className="shrink-0 rounded border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-[var(--sel-bg-hover)]"
                  onClick={() => setExtShown((v) => !v)}
                >
                  {extShown ? '隐藏' : '显示'}
                </button>
                <button
                  type="button"
                  data-ext-copy="1"
                  className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-[var(--sel-bg-hover)]"
                  onClick={() => void copyToken()}
                >
                  {extCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  {extCopied ? '已复制' : '复制'}
                </button>
              </div>
              <p className="mt-1.5 leading-relaxed text-[11px] text-muted-foreground">
                装好扩展后把这条 token 贴进去一次即可（重启应用不用重贴）。
                扩展的排查与验收步骤见扩展目录里的 <code className="rounded bg-background/70 px-1">README.md</code>。
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                {extConfirmReset ? (
                  <>
                    <span className="text-[11px] text-red-500">重置后扩展要重新贴一次，确定？</span>
                    <button
                      type="button"
                      data-ext-reset-confirm="1"
                      disabled={extBusy}
                      className="rounded border border-red-400 px-1.5 py-0.5 text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                      onClick={() => void resetToken()}
                    >
                      {extBusy ? '重置中…' : '确定重置'}
                    </button>
                    <button
                      type="button"
                      data-ext-reset-cancel="1"
                      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-[var(--sel-bg-hover)]"
                      onClick={() => setExtConfirmReset(false)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-ext-reset="1"
                    className="text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                    onClick={() => setExtConfirmReset(true)}
                  >
                    重置配对
                  </button>
                )}
              </div>
              {ext.last_sync && ext.last_sync.keys.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  上次写入的键：{ext.last_sync.keys.join('、')}
                  （整条 cookie 共 {ext.last_sync.cookie_keys} 个键）
                </p>
              )}
            </>
          ) : (
            <p className="mt-1.5 leading-relaxed text-muted-foreground">
              读不到配对信息（后端没起来？）。扩展装好之后可以在那里手填 token。
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
