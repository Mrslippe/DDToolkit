import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
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
import type { AuthStatus, AuthPlatform, QrStartResult } from '../api/types'
import { LOGIN_TABS, XHS_COOKIE_STEPS, loginMode } from '../utils/platformLogin'

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
  const [statuses, setStatuses] = useState<Record<Platform, AuthStatus | null>>({
    bilibili: null,
    weibo: null,
    xiaohongshu: null,
  })
  const [qr, setQr] = useState<QrStartResult | null>(null)
  const [phase, setPhase] = useState<Phase>('generating')
  const [detail, setDetail] = useState('')
  /** 小红书：粘贴框内容 / 保存中 / 保存失败的原文 / 「重新粘贴」是否展开 */
  const [cookie, setCookie] = useState('')
  const [saving, setSaving] = useState(false)
  const [cookieErr, setCookieErr] = useState('')
  const [pasting, setPasting] = useState(false)
  const genSeq = useRef(0)

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

  /** 保存小红书 cookie；成功后用后端返回的登录态刷新本 Tab（不再多发一次 status） */
  const saveCookie = async () => {
    const text = cookie.trim()
    if (!text || saving) return
    setSaving(true)
    setCookieErr('')
    try {
      const s = await api.saveXhsCookie(text)
      setStatuses((prev) => ({ ...prev, xiaohongshu: s }))
      setCookie('')
      setPasting(false)
      toast.success('小红书 cookie 已保存')
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
  /** 当前 Tab 是不是「粘贴 cookie」那一路（小红书） */
  const isCookie = loginMode(platform) === 'cookie'
  /** 小红书：没配过、或点了「重新粘贴」时展开输入框 */
  const showPasteBox = !cur?.logged_in || pasting

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
                  {XHS_COOKIE_STEPS.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <textarea
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  placeholder="a1=…; web_session=…（整条 Cookie）"
                  className="w-full resize-none border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                {(cookieErr || cur?.note) && (
                  <p className="text-xs leading-relaxed text-red-500" data-xhs-cookie-error="1">
                    {cookieErr || cur?.note}
                  </p>
                )}
                <button
                  type="button"
                  disabled={!cookie.trim() || saving}
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
                  小红书 Cookie 在本机 —— 它没有免签名的探活接口，
                  <b className="font-medium text-foreground">是否还有效要等抓取时才知道</b>
                  ；那时重新粘一次即可。
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
      </DialogContent>
    </Dialog>
  )
}
