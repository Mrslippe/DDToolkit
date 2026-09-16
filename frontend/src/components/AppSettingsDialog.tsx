import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Check, ChevronDown, ChevronLeft, ChevronRight, Cloud, Info, Loader2,
  Palette, RotateCcw, Save, Sparkles, Timer, TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import FloatPill from './common/FloatPill'
import { api } from '../api/api'
import type { AppSettings, SettingSpec, StorageInfo } from '../api/types'
import { usePrefs } from '../hooks/usePrefs'
import { formatBytes } from '../utils/format'
import {
  checkForUpdate, deleteOldDataDir, hasPendingUpdate, installUpdate, isDesktopShell,
  migrateDataDir, openReleasePage, pendingUpdateInfo, storageInfo,
  type ShellDataDirInfo, type UpdateInfo,
} from '../utils/shellBridge'

/** 数据目录来源 → 给用户看的话（Rust 侧给的是 env / migrated / default） */
const DIR_SOURCE_LABEL: Record<string, string> = {
  default: '默认位置（%APPDATA%）',
  migrated: '已迁移到其他盘',
  env: '由环境变量 DDTOOLKIT_DATA_DIR 指定',
}
import { themeCards, type ThemePref } from '../utils/theme'
import {
  ABOUT_ID, APPEARANCE_ID, buildNav, buildSections, groupDirty, resetDraftOfGroup,
  type NavIcon,
} from '../utils/settingsNav'
import {
  atBound, buildPayload, bump, dirtyKeys as dirtyOf, fieldError, pairProblems,
  parseField, stepOf, valueOf, type DraftVal,
} from '../utils/settingsDraft'
import OverlayScroll from './OverlayScroll'
import './../styles/posts.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 保存成功后给顶栏一条瞬时消息（与页面其它操作一致） */
  onPill?: (text: string) => void
}

const NAV_ICON: Record<NavIcon, React.ReactNode> = {
  palette: <Palette className="aps-nav-icon" />,
  timer: <Timer className="aps-nav-icon" />,
  activity: <Activity className="aps-nav-icon" />,
  sparkles: <Sparkles className="aps-nav-icon" />,
  cloud: <Cloud className="aps-nav-icon" />,
  info: <Info className="aps-nav-icon" />,
}

/**
 * 应用设置（R14a/R14b 起；**R17（devlog/094）改成左右两栏**）
 * —— IconRail 底端齿轮打开的独立弹窗。
 *
 * 布局参照用户给的参考图：左侧分类导航 + 右侧当前分类的内容；**细节按项目规范**：
 * 近白导航底 + 纯白内容底（镜像外壳的「列表 / 卡片」层次）、选中态沿用
 * 「左缘 3px 主色竖条 + 浅粉底」（`.vtuber-item.active` 那套）、滚动一律 OverlayScroll、
 * 弹窗圆角/阴影走 `--radius-dialog` / `--shadow-dialog`。
 *
 * 四条口径（前三条沿用 R14a/R14b，第四条是 R17 新增）：
 *
 * 1. **范围/单位/生效时机全部来自后端**（`GET /settings` 的 `specs`）。界面不抄阈值 ——
 *    抄一份就是两份口径，用户会看到"界面允许 999、后端拒绝"这种自相矛盾。
 * 2. **可热更 vs 只读摆在一起讲清楚**：可改项每项带"生效时机"，只读项集中列在「关于」并
 *    **逐条说明为什么**。用户看到"不能改"时必须同时看到理由，否则就是"功能没做完"的观感。
 * 3. **写路径只有一条**：保存走 `PUT /settings`，后端做白名单/范围/跨字段校验；
 *    前端只做"提前告诉你会被拒"的即时校验，真正的判定在后端。
 * 4. **导航是数据驱动的**：中间几项由 `specs[].group` 生成（外观固定第一、关于固定最后），
 *    后端加一组参数，界面自动多一项 —— 见 `utils/settingsNav.ts`。
 *
 * ⚠️ 两栏布局的两个坑（都在代码里落实了）：
 * - **切分类不丢草稿**：`draft` 是全局一份，切页只是换渲染；左栏用圆点标出哪页没存。
 * - **报错要看得见**：跨字段冲突（上限 < 下限）涉及的两个字段在同一页，但用户可能翻到
 *   别的页去点保存 —— 所以前端做了同一套跨字段预校验（`settingsDraft.pairProblems`），
 *   让"上限不能小于下限"直接落在出问题的那一行（真判定仍在后端）。
 */
export default function AppSettingsDialog({ open, onOpenChange, onPill }: Props) {
  const [data, setData] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<Record<string, DraftVal>>({})
  const [active, setActive] = useState<string>(APPEARANCE_ID)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  /** 隐藏到托盘 / 主题等界面偏好（R14b 起；R18 起是一个 hook 管全部偏好） */
  const prefs = usePrefs()
  const theme = {
    pref: prefs.pref, setTheme: prefs.setTheme, caveat: prefs.caveat,
    spec: prefs.specOf('theme'), reload: prefs.reload, loaded: prefs.loaded,
  }
  const [themeError, setThemeError] = useState<string | null>(null)
  const navRefs = useRef<Record<string, HTMLButtonElement | null>>({})

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

  /** 导航：外观 → 后端分组 → 关于 */
  const nav = useMemo(
    () => (data ? buildNav(data.specs, theme.spec ? 1 : 0, data.readonly.length) : []),
    [data, theme.spec],
  )

  // 打开时落在外观页；若那一项不存在（后端还没回来）也不至于空白
  useEffect(() => {
    if (nav.length && !nav.some((n) => n.id === active)) setActive(nav[0].id)
  }, [nav, active])

  /** 规格表（后端下发）：`data` 还没回来时是空数组 —— 用 useMemo 固定引用，
      否则下面几个 useMemo 的依赖每次渲染都变（eslint exhaustive-deps 会报） */
  const specs = useMemo(() => data?.specs ?? [], [data])
  const activeItem = nav.find((n) => n.id === active) ?? null
  const groupKeys = useMemo(
    () => (activeItem?.resettable ? specs.filter((s) => s.group === active) : []),
    [specs, active, activeItem],
  )

  /** 页内布局：小组标题 + 页尾「高级（默认收起）」（R21，devlog/100）。
      分组**内容**全部来自后端（`specs[].section` / `.advanced`），界面只负责排版 ——
      后端加一个键、给上 section，它就出现在对应小组里，不必改前端。 */
  const paneLayout = useMemo(
    () => (activeItem?.resettable
      ? buildSections(specs, active)
      : { sections: [], showHeadings: false, advanced: [] }),
    [specs, active, activeItem],
  )
  const specByKey = useMemo(() => {
    const m: Record<string, SettingSpec> = {}
    for (const s of specs) m[s.key] = s
    return m
  }, [specs])

  /** 「高级」是每页各自的默认态：换页就收起（否则"默认收起"只在首屏成立） */
  const [advOpen, setAdvOpen] = useState(false)
  useEffect(() => { setAdvOpen(false) }, [active])

  /** 存储占用（R22-B，devlog/104）：只在打开「关于」页时取一次 —— 后端要**真扫目录**，
      拿它做轮询是浪费。取不到就只显示上面的只读信息，不打扰用户。 */
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [storageBusy, setStorageBusy] = useState<string | null>(null)
  /** 桌面端才知道的信息：数据目录**来源**与是否便携（浏览器/探针环境恒为 null） */
  const [shellDir, setShellDir] = useState<ShellDataDirInfo | null>(null)
  const [migrateBusy, setMigrateBusy] = useState(false)
  /** 迁移成功后保留的旧目录（用户确认后再删） */
  const [oldDir, setOldDir] = useState<string | null>(null)
  useEffect(() => {
    if (!open || active !== ABOUT_ID) return
    let alive = true
    void storageInfo().then((info) => { if (alive) setShellDir(info) }).catch(() => undefined)
    return () => { alive = false }
  }, [open, active])
  useEffect(() => {
    if (!open || active !== ABOUT_ID || storage) return
    let alive = true
    void api.getStorage().then((st) => { if (alive) setStorage(st) }).catch(() => undefined)
    return () => { alive = false }
  }, [open, active, storage])

  /** 迁移数据目录（R22-B2d）：Rust 侧会选目录 → 复制 → 校验 → 切指针 → 重启后端 → 探活；
      失败一律回滚到原目录。这里只负责把结果/错误如实呈现，并留一个"删旧目录"的确认入口。 */
  const doMigrate = async () => {
    setMigrateBusy(true)
    try {
      const got = await migrateDataDir()
      setOldDir(got.oldDir)
      setShellDir(await storageInfo())
      setStorage(await api.getStorage())
      toast.success(`数据已迁移到 ${got.dataDir}（${got.files} 个文件）。`
        + '旧目录仍保留，确认一切正常后可以删掉。')
    } catch (e) {
      toast.error(`迁移未完成：${(e as Error).message}`)
    } finally {
      setMigrateBusy(false)
    }
  }

  const doDeleteOld = async () => {
    if (!oldDir) return
    try {
      const freed = await deleteOldDataDir(oldDir)
      setOldDir(null)
      setStorage(await api.getStorage())
      toast.success(`旧目录已删除，释放 ${formatBytes(freed)}`)
    } catch (e) {
      toast.error(`删除旧目录失败：${(e as Error).message}`)
    }
  }

  /** 应用内更新（R23b）：状态机在本组件，桥接层只管"查 / 装 / 打开发布页" */
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updateState, setUpdateState] =
    useState<'idle' | 'checking' | 'latest' | 'available' | 'error'>('idle')
  const [updateError, setUpdateError] = useState<string | null>(null)
  /** 失败类别：`remote`（远端没有 latest.json，通常=还没发版）与 `network` 的提示不一样 */
  const [updateErrorKind, setUpdateErrorKind] = useState<'network' | 'remote' | 'other'>('other')
  /** 下载/安装中：**独立标记**而不是塞进 `updateState` —— 否则切到 installing 时
      "发现新版本"那个分支就不再渲染，按钮与进度条会当场消失（tsc 的类型收窄先发现的） */
  const [installing, setInstalling] = useState(false)
  const [updatePct, setUpdatePct] = useState<number | null>(null)
  const isShell = isDesktopShell()
  const portable = shellDir?.portable ?? false

  // 启动时的静默检查若已发现新版本，打开关于页就直接显示（不重复发请求）
  useEffect(() => {
    if (!open || active !== ABOUT_ID || !hasPendingUpdate()) return
    const info = pendingUpdateInfo()
    if (info) {
      setUpdate(info)
      setUpdateState('available')
    }
  }, [open, active])

  const doCheckUpdate = async () => {
    setUpdateState('checking')
    setUpdateError(null)
    try {
      const info = await checkForUpdate()
      if (info) {
        setUpdate(info)
        setUpdateState('available')
      } else {
        setUpdate(null)
        setUpdateState('latest')
      }
    } catch (e) {
      const err = e as { message?: string; kind?: 'network' | 'remote' | 'other' }
      setUpdateError(err.message ?? String(e))
      setUpdateErrorKind(err.kind ?? 'other')
      setUpdateState('error')
    }
  }

  const doInstallUpdate = async () => {
    setInstalling(true)
    setUpdatePct(null)
    setUpdateError(null)
    try {
      await installUpdate(setUpdatePct)   // 成功的话进程会自己重启，这里不会继续往下走
    } catch (e) {
      setUpdateError((e as Error).message)
      setUpdateState('error')
    } finally {
      setInstalling(false)
    }
  }

  const runStorageAction = async (kind: 'cache' | 'db') => {
    setStorageBusy(kind)
    try {
      const got = kind === 'cache'
        ? await api.pruneImgCache()
        : await api.runStorageMaintenance()
      setStorage(got.storage)          // 返回里带着最新占用，省一次请求
      if (kind === 'cache') {
        toast.success(`图片缓存已清空，释放 ${formatBytes(got.bytes ?? 0)}`)
      } else {
        toast.success(`数据库已整理：WAL ${formatBytes(got.wal_before ?? 0)} → `
          + `${formatBytes(got.wal_after ?? 0)}，还盘 ${got.freed_pages ?? 0} 页`)
      }
    } catch (e) {
      toast.error(`${kind === 'cache' ? '清理图片缓存' : '整理数据库'}失败：`
        + `${(e as Error).message}`)
    } finally {
      setStorageBusy(null)
    }
  }

  const valueOfKey = (s: SettingSpec): DraftVal => valueOf(s, draft, s.key)

  /** 跨字段冲突（报在"上限"那一行；真判定在后端，这里是同源的提前提示） */
  const pairs = useMemo(() => {
    const shown: Record<string, DraftVal> = {}
    for (const s of specs) shown[s.key] = valueOf(s, draft, s.key)
    return pairProblems(shown)
  }, [specs, draft])
  const pairOf = (key: string) => pairs.find((p) => p.key === key) ?? null

  /** 有问题的项：单字段越界 + 跨字段冲突（两者都会禁用保存） */
  const problems = useMemo(
    () => (data ? data.specs.filter((s) => fieldError(s, valueOf(s, draft, s.key))) : []),
    [data, draft],
  )
  const problemCount = problems.length + pairs.length

  /** 与当前生效值不同的项（只有这些会被提交） */
  const dirtyKeys = useMemo(() => (data ? dirtyOf(data.specs, draft) : []), [data, draft])
  const changedCount = data?.specs.filter((s) => s.changed).length ?? 0

  const save = async () => {
    if (!data || dirtyKeys.length === 0 || problemCount > 0) return
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

  /** 恢复默认：抓取参数（`/settings/reset`）+ 主题（`prefs`）—— 按钮叫"全部"就得真的全部 */
  const resetAll = async () => {
    setBusy('reset')
    setError(null)
    try {
      const res = await api.resetAppSettings()
      await theme.reload()
      await reload()
      toast.success(`已恢复默认（${res.changed.length} 项）`)
      onPill?.('设置已恢复默认')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const pickTheme = async (next: string) => {
    if (next !== 'light' && next !== 'system') return
    setThemeError(null)
    try {
      await theme.setTheme(next as ThemePref)
    } catch (e) {
      // 落库失败：hook 已把界面退回旧值，这里如实说一句
      setThemeError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 关闭语义（R18）：与首次点 ✕ 的询问框写**同一份**偏好 */
  const pickCloseAction = async (next: string) => {
    setThemeError(null)
    try {
      await prefs.setPref('close_action', next)
    } catch (e) {
      setThemeError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 左栏键盘：↑↓ 移动（自动激活）+ Home/End（WAI-ARIA tabs 的垂直变体） */
  const onNavKey = (e: React.KeyboardEvent) => {
    const i = nav.findIndex((n) => n.id === active)
    let next = i
    if (e.key === 'ArrowDown') next = Math.min(nav.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = nav.length - 1
    else return
    e.preventDefault()
    const id = nav[next]?.id
    if (id) {
      setActive(id)
      navRefs.current[id]?.focus()
    }
  }

  const themeState = themeCards()

  /** 一行 = 说明（左）+ 控件（右）。
      抽成函数是为了让「页内小组」与「高级折叠」复用**同一套**渲染 ——
      折叠区里的字段与正文里的是同一种东西，只有"默认看不看得见"的区别。 */
  const renderRow = (s: SettingSpec) => {
    const err = fieldError(s, valueOfKey(s))
    const pair = pairOf(s.key)
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
              {/* 数字框 = 整行步进条（R21 批 2）：左减、中数值、右加。
                  中间仍是真 `<input>`（键盘能直接敲），箭头只是微调 —— 60 秒改 600 秒
                  不该按 540 次。到界置灰的判据在 `settingsDraft.atBound`（有单测）。 */}
              <span className="aps-step">
                <button
                  type="button"
                  className="aps-step-btn"
                  data-step="-1"
                  title="减小"
                  aria-label={`减小${s.label}`}
                  disabled={atBound(s, val, -1)}
                  onClick={() => {
                    const next = bump(s, val, -1)
                    if (next !== null) setDraft((d) => ({ ...d, [s.key]: next }))
                  }}
                >
                  <ChevronLeft className="size-[13px]" />
                </button>
                <input
                  id={`aps-${s.key}`}
                  className="aps-input"
                  type="number"
                  inputMode="decimal"
                  min={s.min ?? undefined}
                  max={s.max ?? undefined}
                  step={stepOf(s)}
                  value={String(val)}
                  onChange={(e) => {
                    const raw = e.target.value
                    setDraft((d) => ({ ...d, [s.key]: parseField(raw, s.kind) }))
                  }}
                />
                <button
                  type="button"
                  className="aps-step-btn"
                  data-step="1"
                  title="增大"
                  aria-label={`增大${s.label}`}
                  disabled={atBound(s, val, 1)}
                  onClick={() => {
                    const next = bump(s, val, 1)
                    if (next !== null) setDraft((d) => ({ ...d, [s.key]: next }))
                  }}
                >
                  <ChevronRight className="size-[13px]" />
                </button>
              </span>
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
        {!err && pair && (
          <span className="aps-field-error" data-pair="1">{pair.message}</span>
        )}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="aps-settings" data-testid="app-settings-dialog">
        <DialogHeader className="aps-settings-head">
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            左侧选择分类。抓取参数改完下一轮生效、不用重启；主题立即生效。
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <p className="aps-error">
            <TriangleAlert className="size-[13px]" /> 读取设置失败：{loadError}
          </p>
        )}

        <div className="aps-body">
          {/* 左栏：分类导航（role=tablist / 竖排 / 自动激活） */}
          <div className="aps-nav" role="tablist" aria-orientation="vertical"
               aria-label="设置分类" data-testid="aps-nav">
            {nav.map((n) => {
              const dirty = n.resettable && groupDirty(specs, draft, n.id)
              const isActive = n.id === active
              return (
                <button
                  key={n.id}
                  ref={(el) => { navRefs.current[n.id] = el }}
                  type="button"
                  role="tab"
                  id={`aps-tab-${n.id}`}
                  aria-selected={isActive}
                  aria-controls="aps-pane"
                  tabIndex={isActive ? 0 : -1}
                  className={`aps-nav-item${isActive ? ' on' : ''}`}
                  data-nav={n.id}
                  data-nav-active={isActive ? '1' : '0'}
                  data-nav-dirty={dirty ? '1' : '0'}
                  onClick={() => setActive(n.id)}
                  onKeyDown={onNavKey}
                >
                  {NAV_ICON[n.icon]}
                  <span className="aps-nav-label">{n.label}</span>
                  {dirty && <i className="aps-nav-dot" aria-label="有未保存改动" />}
                  <span className="aps-nav-count">{n.count}</span>
                </button>
              )
            })}
          </div>

          {/* 右栏：当前分类 */}
          <section className="aps-pane" id="aps-pane" role="tabpanel"
                   aria-labelledby={`aps-tab-${active}`} data-testid="aps-pane"
                   data-pane={active}>
            <header className="aps-pane-head">
              <h3 className="aps-pane-title">
                {activeItem?.label ?? '设置'}
                {activeItem && (
                  <span className="aps-hint">
                    {active === APPEARANCE_ID ? '立即生效' : active === ABOUT_ID
                      ? '只读：这些项改了要重启，或者根本不该由界面改'
                      : '下一轮生效（不用重启）'}
                  </span>
                )}
              </h3>
              {activeItem?.resettable && (
                <button
                  type="button"
                  className="aps-reset-one"
                  data-testid="aps-reset-category"
                  disabled={groupKeys.length === 0}
                  onClick={() => setDraft((d) => ({
                    ...d, ...resetDraftOfGroup(specs, active),
                  }))}
                >
                  <RotateCcw className="size-[12px]" /> 恢复本类默认
                </button>
              )}
            </header>

            <OverlayScroll className="aps-pane-scroll">
              {/* ── 外观（主题；立即生效）────────────────────────────── */}
              {active === APPEARANCE_ID && (
                <div className="aps-theme">
                  <div className="aps-theme-cards" role="radiogroup" aria-label="主题">
                    {themeState.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        role="radio"
                        aria-checked={theme.pref === c.value}
                        data-theme-option={c.value}
                        data-theme-disabled={c.disabled ? '1' : '0'}
                        disabled={c.disabled}
                        title={c.disabled ? '深色主题尚未实现' : c.label}
                        className={`aps-theme-card${theme.pref === c.value ? ' on' : ''}`}
                        onClick={() => void pickTheme(c.value)}
                      >
                        <i className="aps-theme-swatch" data-swatch={c.value} />
                        <span className="aps-theme-label">{c.label}</span>
                        {c.note && <span className="aps-theme-note">{c.note}</span>}
                      </button>
                    ))}
                  </div>
                  <p className="aps-note">{theme.spec?.note
                    ?? '深色主题尚未实现：选「跟随系统」时，系统为深色也仍按浅色显示。'}</p>
                  {theme.caveat && (
                    <p className="aps-range" data-theme-caveat="1">{theme.caveat}</p>
                  )}
                  {themeError && <p className="aps-field-error">{themeError}</p>}

                  {/* 关闭窗口的语义（R18）：与首次点 ✕ 的询问框写同一份偏好。
                      ⚠️ 用 `.aps-row-stack`（说明在上、控件在下占整行）：
                      三个选项塞进右侧 132px 的控件列会被挤成竖排单字
                      （2026-09-15 用户截图反馈）。 */}
                  {prefs.specOf('close_action') && (
                    <div className="aps-row aps-row-stack" data-setting="close_action">
                      <div className="aps-row-main">
                        <span className="aps-label">{prefs.specOf('close_action')!.label}</span>
                        <span className="aps-note">{prefs.specOf('close_action')!.note}</span>
                      </div>
                      <div className="aps-row-ctl aps-radio-group" role="radiogroup"
                           aria-label={prefs.specOf('close_action')!.label}>
                        {prefs.specOf('close_action')!.options.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            role="radio"
                            aria-checked={prefs.closeAction === o.value}
                            data-close-option={o.value}
                            className={`aps-radio${prefs.closeAction === o.value ? ' on' : ''}`}
                            onClick={() => void pickCloseAction(o.value)}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── 抓取参数：页内按用途分组 + 页尾「高级（默认收起）」─────
                  R21（devlog/100）：用户口径「可选项太多、设置很杂，没有专业背景的
                  用户可能不知道每一项意味着什么」⇒ 字段按**用途**分小组，调优类的
                  收进折叠区。分组与折叠的判据全在后端（`Spec.section` / `.advanced`），
                  界面不写死清单 —— 后端加键给 section，界面自动出现。 */}
              {activeItem?.resettable && paneLayout.sections.map((sec) => (
                <section className="aps-section" key={sec.name} data-aps-section={sec.name}>
                  {paneLayout.showHeadings && (
                    <h4 className="aps-section-head">{sec.name}</h4>
                  )}
                  {sec.keys.map((k) => specByKey[k]).filter(Boolean).map(renderRow)}
                </section>
              ))}

              {activeItem?.resettable && paneLayout.advanced.length > 0 && (
                <div className="aps-fold" data-aps-advanced={advOpen ? 'open' : 'closed'}>
                  <button
                    type="button"
                    className="aps-fold-head"
                    data-testid="aps-advanced-toggle"
                    aria-expanded={advOpen}
                    aria-controls="aps-advanced-body"
                    onClick={() => setAdvOpen((v) => !v)}
                  >
                    <ChevronDown className={`aps-fold-caret${advOpen ? ' on' : ''}`} />
                    高级设置（{paneLayout.advanced.length} 项）
                    <span className="aps-fold-hint">微调节奏用，一般不用改</span>
                  </button>
                  {advOpen && (
                    <div className="aps-fold-body" id="aps-advanced-body"
                         data-aps-advanced-body="1">
                      {paneLayout.advanced.map((k) => specByKey[k]).filter(Boolean).map(renderRow)}
                    </div>
                  )}
                </div>
              )}

              {/* ── 关于（只读：信息 + 逐条理由）──────────────────────── */}
              {active === ABOUT_ID && data && (
                <>
                  <dl className="aps-info">
                    <dt>版本</dt><dd>{data.info.version}</dd>
                    <dt>数据目录</dt>
                    <dd className="aps-mono" title={data.info.data_dir}>{data.info.data_dir}</dd>
                    <dt>数据库</dt>
                    <dd className="aps-mono" title={data.info.database}>{data.info.database}</dd>
                    <dt>后端端口</dt><dd>{data.info.port ?? '（由启动器分配）'}</dd>
                    <dt>迁移版本</dt><dd>{data.info.migration_head}</dd>
                    <dt>日志</dt>
                    <dd className="aps-mono" title={data.info.log_file}>{data.info.log_file}</dd>
                    <dt>进程</dt><dd>PID {data.info.pid}</dd>
                  </dl>

                  {/* 存储占用（R22-B）：谁在占地方 + 两个能立刻动手的按钮。
                      起因（用户 2026-09-16）："数据放 C 盘会不会挤爆" ——
                      光显示一个路径不够，得让人**看见数字**、并且能当场清理。 */}
                  <section className="aps-storage" data-testid="aps-storage">
                    <h4 className="aps-section-head">存储占用</h4>
                    {storage ? (
                      <>
                        <dl className="aps-info" data-storage-rows="1">
                          <dt>数据库</dt>
                          <dd data-storage="database">{formatBytes(storage.groups.database.bytes)}</dd>
                          <dt>图片缓存</dt>
                          <dd data-storage="img_cache">
                            {formatBytes(storage.groups.img_cache.bytes)}
                            <span className="aps-storage-cap">
                              （上限 {formatBytes(storage.img_cache_max_bytes)}）
                            </span>
                          </dd>
                          <dt>日志</dt>
                          <dd data-storage="logs">{formatBytes(storage.groups.logs.bytes)}</dd>
                          <dt>合计</dt>
                          <dd data-storage="total">{formatBytes(storage.total_bytes)}</dd>
                          <dt>磁盘剩余</dt>
                          <dd data-storage="free" data-low-space={storage.low_space ? '1' : '0'}>
                            {formatBytes(storage.disk.free)}
                            {storage.low_space && (
                              <em className="aps-storage-warn">空间偏紧</em>
                            )}
                          </dd>
                        </dl>
                        {storage.stale_backups.length > 0 && (
                          <p className="aps-note" data-storage="stale">
                            另有手工备份 {storage.stale_backups.map((b) => b.name).join('、')}
                            （{formatBytes(storage.stale_backups.reduce((n, b) => n + b.bytes, 0))}）——
                            它不是程序生成的，确认没用可以自己删掉。
                          </p>
                        )}
                        <div className="aps-storage-actions">
                          <FloatPill
                            size="md" shape="text"
                            disabled={storageBusy !== null
                              || storage.groups.img_cache.files === 0}
                            onClick={() => void runStorageAction('cache')}
                          >
                            {storageBusy === 'cache' ? '清理中…' : '清理图片缓存'}
                          </FloatPill>
                          <FloatPill
                            size="md" shape="text"
                            disabled={storageBusy !== null}
                            onClick={() => void runStorageAction('db')}
                          >
                            {storageBusy === 'db' ? '整理中…' : '整理数据库'}
                          </FloatPill>
                          {/* 迁移入口只在桌面端、且**不是便携/自定义安装**时出现
                              （用户口径：便携版该整个文件夹一起搬，把数据分出去反而容易丢） */}
                          {shellDir && !shellDir.portable && (
                            <FloatPill
                              size="md" shape="text"
                              data-testid="aps-migrate"
                              disabled={storageBusy !== null || migrateBusy}
                              onClick={() => void doMigrate()}
                            >
                              {migrateBusy ? '迁移中…' : '迁移到其他盘…'}
                            </FloatPill>
                          )}
                        </div>
                        {shellDir && (
                          <p className="aps-note" data-dir-source={shellDir.source}>
                            数据目录来源：
                            {DIR_SOURCE_LABEL[shellDir.source] ?? shellDir.source}
                            {shellDir.portable
                              && '（便携/自定义安装：把整个文件夹搬走即可，应用内不迁移）'}
                          </p>
                        )}
                        {shellDir?.pointerUnusable && (
                          <p className="aps-field-error" data-dir-fallback="1">
                            迁移记录不可用，当前已回退默认目录：{shellDir.pointerUnusable}
                          </p>
                        )}
                        {oldDir && (
                          <p className="aps-note" data-old-dir={oldDir}>
                            旧目录仍保留：<span className="aps-mono">{oldDir}</span>{' '}
                            <FloatPill size="sm" shape="text"
                                       onClick={() => void doDeleteOld()}>
                              删除旧目录
                            </FloatPill>
                            <span className="aps-storage-cap">
                              （确认新目录一切正常后再删）
                            </span>
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="aps-note">读取中…</p>
                    )}
                  </section>

                  {/* 应用更新（R23b）：桌面端才给「检查更新」；**便携版不自我更新**
                      （解压即用的目录不该被安装器覆盖，只提示去发布页下新版压缩包）。 */}
                  <section className="aps-update" data-testid="aps-update">
                    <h4 className="aps-section-head">应用更新</h4>
                    <p className="aps-note">
                      当前版本 <b>{data.info.version}</b>
                      {!isShell && ' · 更新只在桌面端可用'}
                    </p>
                    {isShell && (
                      <>
                        {updateState === 'available' && update ? (
                          <>
                            <p className="aps-note" data-update="available">
                              发现新版本 <b>v{update.version}</b>
                              {update.date ? `（${update.date.slice(0, 10)}）` : ''}
                            </p>
                            {update.notes && (
                              <p className="aps-note aps-update-notes">{update.notes}</p>
                            )}
                            <div className="aps-storage-actions">
                              <FloatPill
                                size="md" shape="text" active
                                data-testid="aps-update-install"
                                disabled={installing}
                                onClick={() => void (portable ? openReleasePage() : doInstallUpdate())}
                              >
                                {portable ? '打开发布页下载'
                                  : installing
                                    ? `下载中 ${updatePct === null ? '…' : `${updatePct}%`}`
                                    : '下载并重启安装'}
                              </FloatPill>
                            </div>
                            {portable && (
                              <p className="aps-note">
                                便携版不自动覆盖：请到发布页下载新版压缩包，解压后替换整个目录。
                              </p>
                            )}
                          </>
                        ) : (
                          <div className="aps-storage-actions">
                            <FloatPill
                              size="md" shape="text"
                              data-testid="aps-update-check"
                              disabled={updateState === 'checking'}
                              onClick={() => void doCheckUpdate()}
                            >
                              {updateState === 'checking' ? '检查中…' : '检查更新'}
                            </FloatPill>
                            <FloatPill size="md" shape="text"
                                       onClick={() => void openReleasePage()}>
                              打开发布页
                            </FloatPill>
                          </div>
                        )}
                        {updateState === 'latest' && (
                          <p className="aps-note" data-update="latest">已是最新版本</p>
                        )}
                        {updateState === 'error' && (
                          <p className="aps-field-error" data-update="error">
                            检查更新失败：{updateError}
                            {updateErrorKind === 'network'
                              ? '（可以检查代理是否正常，或直接去发布页下载）'
                              : updateErrorKind === 'remote'
                                ? '（等新版本发布后再试；也可以直接去发布页看看）'
                                : ''}
                          </p>
                        )}
                      </>
                    )}
                  </section>
                  <ul className="aps-readonly-list">
                    {data.readonly.map((r) => (
                      <li key={r.key} className="aps-readonly-item">
                        <span className="aps-readonly-key">{r.label}</span>
                        <span className="aps-readonly-why">
                          <Info className="size-[12px]" /> {r.why}
                        </span>
                        <code className="aps-readonly-code">{r.key}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {!data && !loadError && <p className="aps-note">读取中…</p>}
            </OverlayScroll>
          </section>
        </div>

        {(error || problemCount > 0) && (
          <p className="aps-error" data-error="1">
            <TriangleAlert className="size-[13px]" />
            {error ?? `${problemCount} 项填写有问题：` +
              [...problems.map((p) => p.label),
               ...pairs.map((p) => specs.find((s) => s.key === p.key)?.label ?? p.key)]
                .join('、')}
          </p>
        )}

        <div className="aps-foot">
          <span className="aps-foot-state" data-dirty={dirtyKeys.length}>
            {changedCount > 0 ? `已改过 ${changedCount} 项` : '全部为默认值'}
            {dirtyKeys.length > 0 && ` · 待保存 ${dirtyKeys.length} 项`}
          </span>
          <div className="aps-foot-actions">
            {/* R21 批 3：弹窗页脚统一成**浮片**（`FloatPill` = 全站唯一的交互层元件，
                斜切白卡 + 阴影，契约见 UI-MAP §C2/§C5）。主操作给 `.on`（主色深填白字）。 */}
            <FloatPill size="md" shape="text" onClick={() => void resetAll()}
                       disabled={busy !== null}>
              {busy === 'reset' ? <Loader2 className="size-[13px] animate-spin" />
                : <RotateCcw className="size-[13px]" />}
              恢复全部默认
            </FloatPill>
            <FloatPill size="md" shape="text" active onClick={() => void save()}
                       disabled={busy !== null || dirtyKeys.length === 0 || problemCount > 0}
                       data-testid="app-settings-save">
              {busy === 'save' ? <Loader2 className="size-[13px] animate-spin" />
                : dirtyKeys.length > 0 ? <Save className="size-[13px]" />
                  : <Check className="size-[13px]" />}
              保存
            </FloatPill>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
