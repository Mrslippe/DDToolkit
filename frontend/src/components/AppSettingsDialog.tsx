import { useEffect, useMemo, useState } from 'react'
import { Check, Info, Loader2, RotateCcw, Save, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '../api/api'
import type { AppSettings, SettingSpec } from '../api/types'
import {
  buildPayload, dirtyKeys as dirtyOf, fieldError, parseField, valueOf,
  type DraftVal,
} from '../utils/settingsDraft'
import OverlayScroll from './OverlayScroll'
import './../styles/posts.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 保存成功后给顶栏一条瞬时消息（与页面其它操作一致） */
  onPill?: (text: string) => void
}

/**
 * 应用设置（R14a，devlog/091）：IconRail 底端齿轮打开的**独立弹窗**。
 *
 * 三个口径写在这里，因为它们决定这个窗口长什么样：
 *
 * 1. **范围/单位/生效时机全部来自后端**（`GET /settings` 的 `specs`）。界面不抄一份阈值 ——
 *    抄一份就是两份口径，用户会看到"界面允许 999、后端拒绝"这种自相矛盾。
 * 2. **可热更 vs 只读要摆在一起讲清楚**：可改的项每项都带"生效时机"（多数是"下一轮生效"），
 *    只读的项集中列在最后并**逐条说明为什么**（数据目录/端口/迁移 head…）。
 *    用户在这里看到"不能改"时，必须同时看到理由，否则就是"功能没做完"的观感。
 * 3. **写路径只有一条**：保存走 `PUT /settings`，后端做白名单/范围/跨字段校验；
 *    前端只做"提前告诉你会被拒"的即时校验（输入框下面的红字），真正的判定在后端。
 */
export default function AppSettingsDialog({ open, onOpenChange, onPill }: Props) {
  const [data, setData] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<Record<string, DraftVal>>({})
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)

  /** 重新拉规格表（打开时 / 保存后 / 恢复默认后） */
  const reload = async () => {
    try {
      const d = await api.appSettings()
      setData(d)
      setDraft({})
      setLoadError(null)
    } catch (e) {
      // 后端不可达：保留旧数据，把原因显示在弹窗顶部（不能静默空白）
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    void reload()
  }, [open])

  /** 当前显示值 = 草稿 → 生效值 */
  const valueOfKey = (s: SettingSpec): DraftVal => valueOf(s, draft, s.key)

  /** 逐项即时校验：范围来自后端 spec（`utils/settingsDraft` 有单测） */
  const errOf = (s: SettingSpec): string | null => fieldError(s, valueOfKey(s))

  const problems = useMemo(
    () => (data ? data.specs.filter((s) => fieldError(s, valueOf(s, draft, s.key))) : []),
    [data, draft],
  )

  /** 与当前生效值不同的项（只有这些会被提交） */
  const dirtyKeys = useMemo(() => (data ? dirtyOf(data.specs, draft) : []), [data, draft])

  const groups = useMemo(() => {
    const out: { name: string; items: SettingSpec[] }[] = []
    for (const s of data?.specs ?? []) {
      const g = out.find((x) => x.name === s.group)
      if (g) g.items.push(s)
      else out.push({ name: s.group, items: [s] })
    }
    return out
  }, [data])

  const save = async () => {
    if (!data || dirtyKeys.length === 0) return
    setBusy('save')
    setError(null)
    try {
      const res = await api.saveAppSettings(buildPayload(dirtyKeys, draft))
      await reload()
      const n = res.changed.length
      toast.success(`已保存 ${n} 项设置 · 下一轮生效`)
      onPill?.(`设置已保存 · ${n} 项`)
    } catch (e) {
      // 后端拒绝（越界/上限小于下限…）：把 detail 原样显示 —— 它已经是中文原因
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const resetAll = async () => {
    setBusy('reset')
    setError(null)
    try {
      const res = await api.resetAppSettings()
      await reload()
      toast.success(`已恢复默认（${res.changed.length} 项）`)
      onPill?.('设置已恢复默认')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const changedCount = data?.specs.filter((s) => s.changed).length ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="aps-settings" data-testid="app-settings-dialog">
        <DialogHeader className="aps-settings-head">
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            抓取节奏、动态流与第三方数据。改完下一轮生效，不用重启；
            只读项在最后，逐条写了为什么不能改。
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <p className="aps-error">
            <TriangleAlert className="size-[13px]" /> 读取设置失败：{loadError}
          </p>
        )}

        <OverlayScroll className="aps-settings-scroll">
          {groups.map((g) => (
            <section className="aps-section" key={g.name}>
              <h3 className="aps-section-title">
                {g.name}
                <span className="aps-hint">{g.items[0].effect}</span>
              </h3>
              {g.items.map((s) => {
                const err = errOf(s)
                const val = valueOfKey(s)
                return (
                  <div className="aps-row" key={s.key} data-setting={s.key}>
                    <div className="aps-row-main">
                      <label className="aps-label" htmlFor={`aps-${s.key}`}>
                        {s.label}
                        {s.changed && <span className="aps-badge">已改过</span>}
                      </label>
                      <span className="aps-note">{s.note}</span>
                    </div>
                    <div className="aps-row-ctl">
                      {s.kind === 'bool' ? (
                        <button
                          type="button"
                          id={`aps-${s.key}`}
                          className={`aps-switch${val ? ' on' : ''}`}
                          data-value={val ? '1' : '0'}
                          role="switch"
                          aria-checked={!!val}
                          onClick={() => setDraft((d) => ({ ...d, [s.key]: !val }))}
                        >
                          <i />
                          {val ? '开' : '关'}
                        </button>
                      ) : (
                        <span className="aps-input-wrap">
                          <input
                            id={`aps-${s.key}`}
                            className="aps-input"
                            type="number"
                            inputMode="decimal"
                            min={s.min ?? undefined}
                            max={s.max ?? undefined}
                            step={s.kind === 'int' ? 1 : 0.1}
                            value={String(val)}
                            onChange={(e) => {
                              const raw = e.target.value
                              setDraft((d) => ({ ...d, [s.key]: parseField(raw, s.kind) }))
                            }}
                          />
                          <em className="aps-unit">{s.unit}</em>
                        </span>
                      )}
                    </div>
                    <span className="aps-range">
                      {s.kind === 'bool'
                        ? (s.default ? '默认：开' : '默认：关')
                        : `范围 ${s.min ?? '-'} ~ ${s.max ?? '-'}${s.unit} · 默认 ${s.default}${s.unit}`}
                    </span>
                    {err && <span className="aps-field-error">{err}</span>}
                  </div>
                )
              })}
            </section>
          ))}

          {/* ── 只读信息（不给改的，逐条说明原因）──────────────────── */}
          <section className="aps-section" data-readonly="1">
            <h3 className="aps-section-title">
              只读信息
              <span className="aps-hint">这些项改了要重启，或者根本不该由界面改 —— 所以只显示</span>
            </h3>
            {data && (
              <dl className="aps-info">
                <dt>版本</dt><dd>{data.info.version}</dd>
                <dt>数据目录</dt><dd className="aps-mono" title={data.info.data_dir}>{data.info.data_dir}</dd>
                <dt>数据库</dt><dd className="aps-mono" title={data.info.database}>{data.info.database}</dd>
                <dt>后端端口</dt><dd>{data.info.port ?? '（由启动器分配）'}</dd>
                <dt>迁移版本</dt><dd>{data.info.migration_head}</dd>
                <dt>日志</dt><dd className="aps-mono" title={data.info.log_file}>{data.info.log_file}</dd>
                <dt>进程</dt><dd>PID {data.info.pid}</dd>
              </dl>
            )}
            <ul className="aps-readonly-list">
              {(data?.readonly ?? []).map((r) => (
                <li key={r.key} className="aps-readonly-item">
                  <span className="aps-readonly-key">{r.label}</span>
                  <span className="aps-readonly-why">
                    <Info className="size-[12px]" /> {r.why}
                  </span>
                  <code className="aps-readonly-code">{r.key}</code>
                </li>
              ))}
            </ul>
          </section>
        </OverlayScroll>

        {(error || problems.length > 0) && (
          <p className="aps-error" data-error="1">
            <TriangleAlert className="size-[13px]" />
            {error ?? `${problems.length} 项填写有问题：${problems.map((p) => p.label).join('、')}`}
          </p>
        )}

        <div className="aps-foot">
          <span className="aps-foot-state" data-dirty={dirtyKeys.length}>
            {changedCount > 0
              ? `已改过 ${changedCount} 项`
              : '全部为默认值'}
            {dirtyKeys.length > 0 && ` · 待保存 ${dirtyKeys.length} 项`}
          </span>
          <div className="aps-foot-actions">
            <Button variant="outline" size="sm" onClick={() => void resetAll()}
                    disabled={busy !== null || changedCount === 0}>
              {busy === 'reset' ? <Loader2 className="size-[13px] animate-spin" />
                : <RotateCcw className="size-[13px]" />}
              全部恢复默认
            </Button>
            <Button size="sm" onClick={() => void save()}
                    disabled={busy !== null || dirtyKeys.length === 0 || problems.length > 0}
                    data-testid="app-settings-save">
              {busy === 'save' ? <Loader2 className="size-[13px] animate-spin" />
                : dirtyKeys.length > 0 ? <Save className="size-[13px]" />
                  : <Check className="size-[13px]" />}
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
