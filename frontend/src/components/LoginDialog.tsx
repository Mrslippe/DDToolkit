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
import type { AuthStatus, QrStartResult } from '../api/types'

type Platform = 'bilibili' | 'weibo'

const PLATFORM_NAME: Record<Platform, string> = { bilibili: 'B 站', weibo: '微博' }

type Phase = 'generating' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 扫码登录浮窗：B 站 / 微博双 Tab 共用一套流程。
 * 生成二维码 → 2s 轮询（waiting/scanned/confirmed/expired/failed）→
 * confirmed 时后端已完成取 cookie 并持久化到 .env。
 */
export default function LoginDialog({ open, onOpenChange }: Props) {
  const [platform, setPlatform] = useState<Platform>('bilibili')
  const [statuses, setStatuses] = useState<Record<Platform, AuthStatus | null>>({
    bilibili: null,
    weibo: null,
  })
  const [qr, setQr] = useState<QrStartResult | null>(null)
  const [phase, setPhase] = useState<Phase>('generating')
  const [detail, setDetail] = useState('')
  const genSeq = useRef(0)

  // 打开时加载两平台登录态
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
    void load('bilibili')
    void load('weibo')
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const start = async (p: Platform) => {
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

  // 打开 / 切 Tab：等该平台登录态加载完成；未登录才自动生成二维码。
  // 依赖 statuses[platform]：避免状态未加载完就对已登录平台误发二维码请求
  // （B 站 / 微博在刚打开对话框时都会白白 start 一次，日志表现为 qrcode 双请求）。
  useEffect(() => {
    if (!open) {
      setQr(null)
      setPhase('generating')
      return
    }
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>账号登录</DialogTitle>
          <DialogDescription>
            扫码登录后用于平台数据抓取；凭据仅保存在本机（.env）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          {(['bilibili', 'weibo'] as Platform[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`flex-1 border py-1.5 text-sm transition-colors ${
                platform === p
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border text-muted-foreground hover:bg-[var(--sel-bg-hover)]'
              }`}
              onClick={() => setPlatform(p)}
            >
              {PLATFORM_NAME[p]}
              {statuses[p]?.logged_in ? ' · 已登录' : ''}
            </button>
          ))}
        </div>

        <div className="flex min-h-[228px] flex-col items-center justify-center gap-3">
          {showLoggedIn ? (
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
                  className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-[var(--sel-bg-hover)]"
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
