import { useEffect, useState } from 'react'
import { api, resolveAsset } from '../../api/api'
import type { FanProfile } from '../../api/types'
import { resolveAvatarSources } from '../../utils/avatarSource'
import { withNetRetry } from '../../utils/netRetry'
import ProxyImage from '../common/ProxyImage'

interface VOption {
  name: string
  short: string
  has_data: boolean
  sessions: number
}

interface Props {
  /** 当前选中的主播显示名 */
  name: string
  /** 可切换的主播（2026-10-18 用户：切换按钮放进档案卡，不再占热力图卡一行） */
  options?: VOption[]
  onPick?: (name: string) => void
}

/** 覆盖率低于这个值时，进度条给一条最短可见宽度（否则 6% 细得看不见） */
const MIN_BAR = 1.5

function fmtFans(n: number | null): string {
  if (!n) return '—'
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万粉` : `${n} 粉`
}

function mmdd(iso: string | null): string {
  return iso ? iso.slice(5).replace('-', '-') : '—'
}

/**
 * 工作台档案卡（2026-10-18，V2）。
 *
 * 用户口径：「档案卡还有很多空余，把之前放不下的也给放进去」，并按重要性排序逐个放，
 * 到拥挤为止。落成**两个区**（`docs/plans/workbench-visual-redesign.md` §3.5）：
 *
 * - **A 区 · 读数行**（最多 3 项，高频扫读）：已采/总场次 · 粉丝数 · 最近一场
 * - **B 区 · 补充区**（最多 3 块，等高之后才有的空间）：签名 · 企划徽章 · 采集覆盖率
 *
 * ⚠️ 字段缺失时**整块不渲染**，不留空胶囊 —— 明前奶绿没有企划，那一行就是空的。
 *
 * 头像 / 背景 / 签名全部来自 `GET /fan/{v}/profile` 里的 `vtuber`（= `VTuberOut`），
 * 与左栏走**同一条**解析链（`ProxyImage` + `resolveAsset`），不另造一套。
 */
export default function ProfileCard({ name, options = [], onPick }: Props) {
  const [data, setData] = useState<FanProfile | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setErr(null)
    setData(null)
    withNetRetry(() => api.fanProfile(name))
      .then((r) => { if (alive) setData(r) })
      .catch((e: Error) => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [name])

  if (err) {
    return (
      <section className="wb-card wb-profile" data-testid="profile-card">
        <p className="wb-hint is-error">⚠ {err}</p>
      </section>
    )
  }
  if (!data) {
    return (
      <section className="wb-card wb-profile" data-testid="profile-card">
        <div className="wb-empty"><p>读取档案…</p></div>
      </section>
    )
  }

  const v = data.vtuber
  const s = data.stats
  const group = (v.group_name || v.faction || '').trim()
  const sign = (v.sign_override || '').trim()
  const bg = resolveAsset(v.background_path)
  /* ⚠️ 与左栏**同一个函数**（`devlog/135` 的教训：各写一条链，迟早漂开）。
     2026-10-18 实测踩到：只读 `v.avatar`（覆盖字段）⇒ dev 库里它是空的，
     于是左栏有头像、工作台只有首字兜底。 */
  const avatar = resolveAvatarSources(v, data.accounts)
  const pct = Math.round(s.coverage * 1000) / 10

  return (
    <section className="wb-card wb-profile" data-testid="profile-card">
      {bg && <div className="wb-profile-bg" style={{ backgroundImage: `url("${bg}")` }} />}
      <div className="wb-profile-scrim" />
      <div className="wb-profile-body">
        <div className="wb-profile-top">
          <ProxyImage
            className="wb-profile-avatar"
            alt={v.name}
            src={avatar.src}
            fallbackSrc={resolveAsset(avatar.local)}
            fallbackClassName="wb-profile-avatar wb-profile-avatar-fb"
            fallback={<span>{v.name.slice(0, 1)}</span>}
          />
          <div className="wb-profile-id">
            {/* 主播切换器就长在名字上：不给它单独一行，也不藏进别处 */}
            {options.length > 1 && onPick ? (
              <select className="wb-name-select" value={name} title={v.name}
                      aria-label="切换主播"
                      onChange={(e) => onPick(e.target.value)}
                      data-testid="workbench-vtuber">
                {options.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.short}{o.has_data ? '' : '（无数据）'}
                  </option>
                ))}
              </select>
            ) : (
              <h1 className="wb-profile-name" title={v.name}>{v.name}</h1>
            )}
            {/* A 区：最多 3 项 */}
            <div className="wb-profile-meta" data-testid="profile-meta">
              <span>
                <b className="is-acc">{s.collected}</b> / {s.total_sessions} 场可分析
              </span>
              <span className="sep" />
              <span>{fmtFans(s.followers)}</span>
              <span className="sep" />
              <span>最近 <b>{mmdd(s.last)}</b></span>
            </div>
          </div>
        </div>

        {/* B 区：最多 3 块，缺了就整块不渲染 */}
        {group && (
          <div className="wb-profile-badges">
            <span className="wb-badge" data-testid="profile-group">{group}</span>
          </div>
        )}
        {sign && <p className="wb-profile-sign" data-testid="profile-sign">「{sign}」</p>}

        <div className="wb-profile-cover">
          <div className="wb-profile-cover-row">
            <span>采集覆盖</span>
            <span>
              <b>{s.collected} / {s.total_sessions} 场（{pct}%）</b>
              {s.first && <> · {s.first} 起</>}
            </span>
          </div>
          <div className="wb-bar">
            <span className="wb-bar-fill"
                  style={{ width: `${Math.min(100, Math.max(MIN_BAR, pct))}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}
