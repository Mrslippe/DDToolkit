/**
 * 托盘状态行文案（R29，devlog/129）。
 *
 * 为什么需要它：后端把「风控冷却」做进了顶栏状态岛，但**窗口收进托盘后没人看界面** ——
 * 用户既不知道被限流了、也不知道还要等多久。壳那边有现成的落点（托盘 tooltip 与菜单项
 * `status`），这里只负责把 `fetch-status.rate_limit` 折成一句人话。
 *
 * 纯函数（可单测）：返回 `null` = 没有要显示的状态 ⇒ 壳复位成「后台运行中」。
 */
const PLATFORM_LABEL: Record<string, string> = {
  bilibili: 'B 站',
  weibo: '微博',
}

export interface TrayRateLimit {
  active: boolean
  reason?: string
  seconds_left: number
  platform?: string
  hits?: number
}

/** 平台代号 → 人话（未收录的代号原样返回；空值返回空串）。 */
export function platformLabel(platform?: string): string {
  if (!platform) return ''
  return PLATFORM_LABEL[platform] ?? platform
}

/**
 * 冷却中的一行文案；**不在冷却时返回 `null`**（壳据此复位）。
 *
 * 形如 `风控冷却中 · B 站 · 剩余 8 分钟`，连续命中第 2 次起追加 `连续第 N 次`
 * （R27 的升级梯度让"第几次"有意义：10 → 20 → 40 分钟）。
 */
export function trayStatusText(rl: TrayRateLimit | null | undefined): string | null {
  if (!rl?.active) return null
  const secs = Math.max(0, Math.round(rl.seconds_left ?? 0))
  const mins = Math.max(1, Math.ceil(secs / 60))       // 不足 1 分钟也显示 1 分钟，别显示 0
  const parts = ['风控冷却中']
  const who = platformLabel(rl.platform)
  if (who) parts.push(who)
  parts.push(`剩余 ${mins} 分钟`)
  if ((rl.hits ?? 0) > 1) parts.push(`连续第 ${rl.hits} 次`)
  return parts.join(' · ')
}
