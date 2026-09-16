import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { History, ImagePlus, Loader2, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import FloatPill from './common/FloatPill'
import { api, resolveAsset } from '../api/api'
import type { Account, VTuber } from '../api/types'
import { PLATFORM_LABEL } from '../utils/postTypes'
import { buildSignOptions, type SignOption as SignOptionData } from '../utils/signOptions'
import { resolveSign } from '../utils/signSource'
import AddAccountDialog from './AddAccountDialog'
import AccountHistoryDialog from './AccountHistoryDialog'
import OverlayScroll from './OverlayScroll'
import ProxyImage from './common/ProxyImage'
import './../styles/posts.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  vtuber: VTuber | null
  /** 保存后回调（父级刷新本体 + 选中账号） */
  onSaved: (v: VTuber) => void
  /** 召唤顶栏胶囊提示（与页面其它操作一致） */
  onPill?: (text: string) => void
}

/**
 * 档案设置窗口（P8-B，2026-09-10 用户）：背景 / 头像 / 签名 / 已订阅账号管理
 * （原「基本资料」一节 2026-09-13 按用户口径整节删除，见 devlog/067 §四）。
 *
 * 设计取舍：
 * - **全部实时生效**：头像点击即写、签名失焦即提交、背景上传即写（没有"保存"按钮，
 *   也就没有"这条到底存没存"的歧义 —— 见 devlog/067）；
 * - **签名来源与覆盖（A3，2026-09-13，devlog/074）**：卡片签名 =
 *   `vtubers.sign_override`（手改的覆盖）→ `sign_source_account_id` 指向的账号 → 主账号；
 *   **平台签名（`accounts.sign`）只读**，下拉选的是"用哪个平台的签名"，不复制不改写；
 * - **字段锁定已退役**：昵称/签名允许被抓取更新；旧值由 `vtuber_field_history` 记账
 *   （曾用名 / 曾用签名）。⚠️ 2026-09-13（devlog/075，用户口径）：那份记录归
 *   「账号信息历史快照」一类，**暂不在本窗口展示**（手改也不入账，只记平台侧被覆盖的旧值）。
 * - 头像只能选账号的**远端 URL**（`vtubers.avatar` 不走 resolveAsset，
 *   写本地相对路径会拼错前缀）。
 */
/**
 * 回车 = 主动失焦（失焦即提交，见 `commitSign`）—— 让"打完字敲回车"也能落地。
 * 下拉展开时由 `onSignKeyDown` 接管，不走这条。
 */
function blurOnEnter(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    ;(e.target as HTMLElement).blur()
  }
}

const SIGN_LIST_ID = 'vd-sign-list'
/** 浮层面板最大高度（与 CSS `.vd-sign-panel` 的 max-height 保持一致；定位要用它估高） */
const SIGN_PANEL_MAX_H = 260
const signOptionId = (id: number | undefined) => (id == null ? undefined : `vd-sign-opt-${id}`)

/**
 * 候选行（2026-09-13 设计案，devlog/072）：**单行** = 签名文字（弹性、可横向滚动）
 * + 右端固定的平台名胶囊；文字过长时在平台名之前**渐隐**（`mask-image`）。
 *
 * ⚠️ 两个容易做错的地方（写在这里，免得下次当 bug 修）：
 * 1. **渐隐只在真的溢出时才加**（`.ovf`）：无条件挂 mask 会把短签名的结尾也虚掉，
 *    看起来像渲染坏了。溢出判定用 `scrollWidth > clientWidth`（布局完成后量）。
 * 2. 弹性子项要 `min-width:0`（CSS 里已写死）：漏了它 flex 会把文字撑破面板，
 *    横向滚动与渐隐同时失效 —— 而且**不报错**，只是看着不对。
 *
 * 交互（用户 2026-09-13 定：只留 hover 自动滚一次）：悬停平滑滚到结尾，
 * 移出立刻回起点（下次悬停重播）；不做滚轮转横向、不做跑马灯循环。
 */
function SignOption({ option, cursor, onPick }: {
  option: SignOptionData
  cursor: boolean
  onPick: () => void
}) {
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)

  // 面板每次展开都是新挂载 → 挂载时量一次，内容变化时重量（续接 ResizeObserver）
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    const check = () => setOverflow(el.scrollWidth - el.clientWidth > 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [option.sign])

  const reveal = () => {
    const el = textRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ left: el.scrollWidth, behavior: reduce ? 'auto' : 'smooth' })
  }
  const reset = () => {
    const el = textRef.current
    if (el) el.scrollTo({ left: 0, behavior: 'auto' })
  }

  return (
    <div
      id={signOptionId(option.id)}
      role="option"
      aria-selected={option.active}
      tabIndex={-1}
      className={`vd-sign-opt${option.active ? ' on' : ''}${cursor ? ' cur' : ''}`}
      onClick={onPick}
      onMouseEnter={reveal}
      onMouseLeave={reset}
      onFocus={reveal}
      onBlur={reset}
    >
      <span className={`vd-sign-text${overflow ? ' ovf' : ''}`} ref={textRef}>
        {option.sign}
      </span>
      <span className="vd-sign-plat">
        {option.label}
        {option.isHero && <em>主账号</em>}
      </span>
    </div>
  )
}

export default function VtuberSettingsDialog({
  open,
  onOpenChange,
  vtuber,
  onSaved,
  onPill,
}: Props) {
  const [sign, setSign] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<Account | null>(null)
  /** 「账号信息历史」弹窗的目标账号（R9，devlog/080） */
  const [histTarget, setHistTarget] = useState<Account | null>(null)
  /** 各平台签名下拉栏（2026-09-13 设计案，devlog/072）：展开态 / 键盘游标 / 定位 */
  const [signPopOpen, setSignPopOpen] = useState(false)
  const [signCursor, setSignCursor] = useState<number | null>(null)
  const signPanelRef = useRef<HTMLDivElement>(null)
  /** 输入条包装（含输入框与 chevron）——"点外部关闭"要把**它**也算内部，否则
   *  点 chevron 会先被 mousedown 判成"外部"关掉、再被 click 打开 ⇒ 看着像闪一下没关 */
  const signFieldRef = useRef<HTMLDivElement>(null)
  /**
   * 面板定位：**绝对定位在弹窗内容体里**（2026-09-13 用户实测"点不动"后的第三次改版，
   * devlog/075）——为什么不再 portal 到 body + `position:fixed`：
   *
   * ① radix 模态弹窗会给 `document.body` 打 `pointer-events:none`（只有它自己的内容体
   *    被内联改回 `auto`）。面板 portal 到 body ⇒ 继承 `none` ⇒ **hover 与点击全部失灵**
   *    （用户报的就是这个：看得见、点不着，且没有任何报错）；
   * ② 面板若 portal 到 body 再改成 `pointer-events:auto`，它又落回"弹窗之外"：
   *    radix 会把行上的 pointerdown 当成"点了外面"→ 关掉整个弹窗；
   * ③ 内容体本身带 `translate-x/y-[-50%]`（**是包含块**），所以就算 portal 进去，
   *    `position:fixed` 也会退化"相对内容体"，坐标全错。
   *
   * 结论：**不做 portal**，直接把面板渲染成「弹窗内容体的直接子元素」（在滚动体之外）：
   * 天然共享 `pointer-events:auto`、天然被 radix 视为内部、天然不被 `.vd-settings-scroll`
   * 的 `overflow:hidden` 裁掉（它根本不在那个盒子里）；坐标按内容体算（见 placePanel）。
   *
   * ⚠️ 包含块元素用 `closest('.vd-settings')` 找，**不给 DialogContent 传 ref**：
   * `components/ui/dialog.tsx` 的 `DialogContent` 是普通函数组件（React 18 下 ref 会被
   * 静默丢弃，实测面板因此根本不渲染 —— placePanel 提前 return，探针量到 rows=-1）。
   */
  /** 面板位置：相对**弹窗内容体**（`position:absolute` 的包含块）的坐标 */
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null)

  /**
   * 给面板定位（2026-09-13 用户二次口径：**浮在下面内容之上**，不推挤它们）。
   *
   * - 锚点 = 输入条矩形；宽度与它一致（参考图的结构关系）；
   * - 坐标是**相对弹窗内容体的 padding box**（`position:absolute` 的起点），
   *   所以要减掉内容体矩形与它的边框宽度 —— 见 dialogRef 注释里为什么不用 fixed；
   * - 下方放不下且上方更宽裕 → **向上翻转**（拿视口剩余空间判，避免贴着窗口底）；
   * - 监听 `scroll`（**捕获阶段**：滚动不冒泡，捕获才能收到 OverlayScroll 内部滚动）
   *   与 resize 重新定位 —— 弹窗内容滚动时面板跟着输入条走。
   */
  const placePanel = useCallback(() => {
    const field = signFieldRef.current
    const anchor = field?.querySelector<HTMLElement>('input')
    // 包含块 = 弹窗内容体（`.vd-settings` 上是 `position:relative`）；见上方注释为什么不用 ref
    const box = field?.closest<HTMLElement>('.vd-settings')
    if (!anchor || !box) return
    const r = anchor.getBoundingClientRect()
    const br = box.getBoundingClientRect()
    const cs = getComputedStyle(box)
    const padLeft = (parseFloat(cs.borderLeftWidth) || 0)
    const padTop = (parseFloat(cs.borderTopWidth) || 0)
    const h = Math.min(signPanelRef.current?.scrollHeight ?? SIGN_PANEL_MAX_H,
                       SIGN_PANEL_MAX_H)
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    const openUp = below < h + 6 && above > below
    const left = r.left - br.left - padLeft
    const topBelow = r.bottom - br.top - padTop + 6
    const topAbove = r.top - br.top - padTop - 6 - h
    setPanelStyle({
      position: 'absolute',
      left,
      width: r.width,
      top: openUp ? topAbove : topBelow,
    })
  }, [])
  const fileRef = useRef<HTMLInputElement>(null)

  const hero = useMemo(() => {
    if (!vtuber) return undefined
    return vtuber.accounts.find((a) => a.platform === 'bilibili') ?? vtuber.accounts[0]
  }, [vtuber])

  /**
   * 草稿播种键：**只在「打开窗口 / 换 V / 换主账号」时重播种**。
   *
   * 2026-09-10 用户反馈的 bug：动态轮询每完成一轮 → `fetch-idle` → 父级 `setVtuber(新对象)`
   * （以及 `account-progress` 的合并快照）→ 本组件 effect 依赖里的 `vtuber`/`hero` 换了
   * 引用 → 整个草稿被服务端值覆盖，用户改一项丢一项。
   * 依赖数组治不了这个：对象引用每次刷新都是新的，而草稿是**用户正在编辑的状态**，
   * 不该被任何后台刷新打断。故改成显式播种键（打开态 + V id + 主账号 id）。
   */
  const seedRef = useRef('')
  /**
   * 已保存值快照：**判断"这次失焦到底有没有改动"**（避免 tab 过一遍就打无意义的 PUT）。
   * 存的是**输入框里那次播种的文本**（= 当时的生效签名），不是 `sign_override` —— 见 commitSign。
   */
  const savedRef = useRef({ sign: '' })

  useEffect(() => {
    if (!open || !vtuber) return
    const key = `${vtuber.id}:${hero?.id ?? ''}`
    if (seedRef.current === key) return
    seedRef.current = key
    // 播种 = **当前生效的签名**（覆盖 ?? 来源账号 ?? 主账号），与卡片同口径
    const seed = { sign: resolveSign(vtuber, vtuber.accounts).text }
    savedRef.current = seed
    setSign(seed.sign)
    setAvatar(vtuber.avatar ?? null)
  }, [open, vtuber, hero])
  // 关闭即作废播种键：下次打开（哪怕是同一个 V）重新以最新服务端值起稿
  useEffect(() => {
    if (!open) seedRef.current = ''
  }, [open])

  /**
   * 头像**选中即写入**（R1，2026-09-13；用户补充：去掉「用平台默认」，点哪个是哪个）。
   *
   * 不设"清空头像"这条路：没有显式选择时，卡片显示的就是**首个账号的头像**
   * （`PostsPage` 的 stableAvatar 回退链），所以"默认头像"只在**一个账号都没加**时出现。
   */
  const pickAvatar = async (url: string) => {
    if (!vtuber || saving || url === (avatar ?? '')) return
    const prevAvatar = avatar
    setAvatar(url)                     // 乐观更新：立即回显选中态
    setSaving(true)
    try {
      onSaved(await api.updateVtuber(vtuber.id, { avatar: url }))
      onPill?.('头像已更新')
    } catch (e) {
      setAvatar(prevAvatar)            // 失败回滚选中态，不让 UI 撒谎
      toast.error(`头像保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  /**
   * 签名**失焦即提交**（R1 补充，2026-09-13：「修改要么实时生效，要么全部都需要保存」）。
   *
   * 2026-09-13 第三轮（devlog/074，用户选 A3）：提交的是 **`vtubers.sign_override`**
   * （手改的覆盖），**不再写 `accounts.sign`** —— 平台签名是平台的事实，只读。
   *
   * 关键约定（不这么写就会"顺手造出覆盖"）：
   * - 播种时 `savedRef.sign` = **当时输入框里的生效文本**（可能是来源账号的签名）；
   * - 提交时只有**文本真的被改过**才写 override；
   * - 清空输入框 → `sign_override = null`，回到"跟随来源账号"（这是撤销覆盖的入口）；
   * - 覆盖与来源的关系：**选来源会清掉覆盖**（见 pickSource）——否则"选了没反应"。
   *
   * ⚠️ 关窗时若焦点还在输入框里（Esc 就是这条路径），DOM blur 不保证触发 →
   * 卸载时 flush 兜底（见下方 `flushRef`）。
   */
  const commitSign = async (value?: string): Promise<void> => {
    if (!vtuber || saving) return
    const s = savedRef.current
    const next = { sign: (value ?? sign).trim() }
    setSign(next.sign)                 // 下拉栏路径：先回显再提交
    if (next.sign === s.sign) return
    setSaving(true)
    try {
      onSaved(await api.updateVtuber(vtuber.id, { sign_override: next.sign || null }))
      savedRef.current = next
      onPill?.(next.sign ? '已设为自定义签名（平台签名不受影响）'
                         : '已撤销自定义签名，跟随平台')
    } catch (e) {
      setSign(s.sign)                  // 回滚到"最后一次成功保存"的值，不让界面撒谎
      toast.error(`保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  /**
   * 选择"卡片签名跟随哪个平台"（A3 的核心动作）。
   *
   * 写 `sign_source_account_id` + **清掉 `sign_override`**：
   * 有覆盖在时选来源不会有任何可见变化（覆盖优先），那才是真的"点了没反应"。
   * **不写 `accounts.sign`**：平台签名只读，点一下不会改掉别的平台的签名
   * （2026-09-13 用户实测反馈的那个 bug）。
   */
  const pickSource = async (accountId: number | null) => {
    if (!vtuber || saving) return
    setSignPopOpen(false)
    setSaving(true)
    const prevOverride = vtuber.sign_override
    try {
      const updated = await api.updateVtuber(vtuber.id, {
        sign_source_account_id: accountId, sign_override: null,
      })
      onSaved(updated)
      const text = resolveSign(updated, updated.accounts).text
      savedRef.current = { sign: text }
      setSign(text)                    // 输入框跟着显示新来源的签名
      onPill?.('已切换签名来源（各平台签名均未被修改）')
    } catch (e) {
      // 回滚：把覆盖写回去，别让失败留下"覆盖被清掉"的副作用
      if (prevOverride) {
        try {
          onSaved(await api.updateVtuber(vtuber.id, { sign_override: prevOverride }))
        } catch { /* 回滚失败只能靠刷新，下面的 toast 已说明 */ }
      }
      toast.error(`切换来源失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const uploadBackground = async (file: File) => {
    if (!vtuber) return
    setUploading(true)
    try {
      const updated = await api.uploadBackground(vtuber.id, file)
      onSaved(updated)
      onPill?.('背景已更新')
    } catch (e) {
      toast.error(`背景上传失败：${(e as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  const clearBackground = async () => {
    if (!vtuber) return
    try {
      onSaved(await api.clearBackground(vtuber.id))
      onPill?.('已清除自定义背景')
    } catch (e) {
      toast.error(`清除背景失败：${(e as Error).message}`)
    }
  }

  // 关窗兜底：Esc 关窗时输入框可能没触发 blur（焦点元素被卸载不派发 blur）
  const flushRef = useRef(commitSign)
  flushRef.current = commitSign
  useEffect(() => () => { void flushRef.current() }, [])

  // 签名下拉栏：点外部 / Esc 关闭。
  // ⚠️ "外部" = 既不在**输入条包装**里、也不在面板里。少了输入条那一半，
  //    点 chevron 会被 mousedown 先判成"外部"关掉、再被 click 打开 ⇒ 看着像"闪一下没关"
  //    （2026-09-13 用户实测反馈）；面板是 portal 出去的，所以要用它自己的 ref 单独判。
  useEffect(() => {
    if (!signPopOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (signFieldRef.current?.contains(t)) return
      if (signPanelRef.current?.contains(t)) return
      setSignPopOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()          // 只关下拉，不把整个弹窗一起关掉
        setSignPopOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [signPopOpen])

  // 展开：定位 → 之后**持续跟随**（见下）。收起时把位置清掉，避免下次用旧坐标闪一帧。
  //
  // ⚠️ 为什么不能只量一次（2026-09-13 实测，devlog/075）：
  //    ① 弹窗入场有 `zoom-in-95`（**transform 缩放**），开面板那一刻量到的是缩小态 ——
  //       而 **ResizeObserver 不会被 transform 触发**（它看的是布局盒，缩放不改布局），
  //       于是面板宽度/位置停在 ~97% 那一版（探针量到 输入条 424.9 / 面板 412.1）；
  //    ② 弹窗内容在开面板后还会长高（头像图加载、账号列表渲染）→ 输入条**位置**变了，
  //       但它的**尺寸**没变 → 任何"只看尺寸"的观察者都不会醒。
  //    所以：开面板后先跑一段 rAF（覆盖入场动画与首屏数据落位），期间只要锚点矩形变了
  //    就重定位；之后交给 RO（锚点/内容体/内容包裹层）+ scroll/resize 兜底。
  useEffect(() => {
    if (!signPopOpen) {
      setSignCursor(null)
      setPanelStyle(null)
      return
    }
    placePanel()
    const anchor = signFieldRef.current?.querySelector<HTMLElement>('input')
    const box = signFieldRef.current?.closest<HTMLElement>('.vd-settings') ?? null
    const inner = box?.querySelector<HTMLElement>('.os-scroll') ?? null
    let last = anchor?.getBoundingClientRect() ?? null
    let frames = 0
    let raf = 0
    const tick = () => {
      const r = anchor?.getBoundingClientRect() ?? null
      if (r && (!last || Math.abs(r.left - last.left) > 0.25 ||
                Math.abs(r.top - last.top) > 0.25 ||
                Math.abs(r.width - last.width) > 0.25)) {
        last = r
        placePanel()
      }
      if (++frames < 90) raf = requestAnimationFrame(tick)   // ~1.5s：入场动画 + 首屏落位
    }
    raf = requestAnimationFrame(tick)
    const ro = new ResizeObserver(() => placePanel())
    if (anchor) ro.observe(anchor)
    if (box) ro.observe(box)
    if (inner) ro.observe(inner)
    const onMove = () => placePanel()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    // 入场动画结束的那一刻再校正一次（transform 消失后矩形才是最终值）
    box?.addEventListener('animationend', onMove)
    box?.addEventListener('transitionend', onMove)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      box?.removeEventListener('animationend', onMove)
      box?.removeEventListener('transitionend', onMove)
    }
  }, [signPopOpen, placePanel])

  const removeAccount = async () => {
    if (!delTarget || !vtuber) return
    try {
      await api.deleteAccount(delTarget.id)
      onSaved(await api.getVtuber(vtuber.id))
      onPill?.(`已解除 ${delTarget.platform} 账号订阅`)
    } catch (e) {
      toast.error(`删除账号失败：${(e as Error).message}`)
    } finally {
      setDelTarget(null)
    }
  }

  const bg = resolveAsset(vtuber?.background_path ?? null)
  const avatarOptions = (vtuber?.accounts ?? []).filter((a) => a.avatar_url)
  /** 生效签名与来源（与卡片同口径：覆盖 → 来源账号 → 主账号） */
  const resolved = resolveSign(vtuber, vtuber?.accounts ?? [])
  /** 签名下拉栏的行数据（整形逻辑在 `utils/signOptions.ts`，有 6 条断言） */
  const signOptions = buildSignOptions(vtuber?.accounts ?? [], hero?.id ?? null, sign)
  /** 签名区 hint：说清"现在编辑的是什么、卡片跟随谁" */
  const signHint = !hero
    ? '暂无账号'
    : resolved.from === 'override'
      ? '正在编辑：自定义覆盖（平台签名不受影响）· 保存后点别处即生效'
      : resolved.accountId != null
        ? `跟随「${PLATFORM_LABEL[resolved.from === 'account'
            ? (vtuber?.accounts.find((a) => a.id === resolved.accountId)?.platform ?? '')
            : ''] ?? ''}」账号 · 输入即变为自定义覆盖`
        : '暂无签名 · 输入即设为自定义覆盖'

  /**
   * 输入框键盘：面板展开时接管 ↑/↓/Enter/Esc（combobox 口径），
   * 收起时保持老行为（Enter = 主动失焦 → 提交）。
   */
  const onSignKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!signPopOpen) {
      if (e.key === 'ArrowDown' && signOptions.length > 0) {
        e.preventDefault()
        setSignPopOpen(true)
        return
      }
      blurOnEnter(e)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = signOptions.length
      if (n === 0) return
      const cur = signCursor ?? -1
      const next = e.key === 'ArrowDown' ? (cur + 1) % n : (cur - 1 + n) % n
      setSignCursor(next)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const picked = signCursor != null ? signOptions[signCursor] : null
      if (picked) {
        setSignPopOpen(false)
        void commitSign(picked.sign)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setSignPopOpen(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="vd-settings max-w-lg">
          <DialogHeader className="vd-settings-head">
            <DialogTitle>档案设置</DialogTitle>
            <DialogDescription>
              背景 / 头像 / 签名与已订阅账号；改动点了就生效（无需保存）。
              签名可跟随任一平台，也可自定义覆盖 —— 平台自己的签名不会被改动。
            </DialogDescription>
          </DialogHeader>

          <OverlayScroll className="vd-settings-scroll">
            <div className="vd-section">
              <h4 className="vd-section-title">背景</h4>
              <div className="vd-bg-row">
                <div
                  className="vd-bg-preview"
                  style={bg ? { backgroundImage: `url(${bg})` } : undefined}
                >
                  {!bg && <span>头像铺底</span>}
                </div>
                <div className="vd-bg-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ImagePlus className="size-4" />
                    )}
                    更换背景图
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!bg}
                    onClick={clearBackground}
                  >
                    <Trash2 className="size-4" />
                    清除
                  </Button>
                </div>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void uploadBackground(f)
                }}
              />
            </div>

            <div className="vd-section">
              <h4 className="vd-section-title">
                头像
                <span className="vd-hint">
                  {avatarOptions.length > 0 ? '点哪个用哪个（点完即生效）' : '添加账号后可选'}
                </span>
              </h4>
              <div className="vd-avatar-row">
                {avatarOptions.map((a, i) => {
                  const src = resolveAsset(a.avatar_path) ?? a.avatar_url ?? undefined
                  // 未显式选过时，**首个账号即当前生效头像**（卡片回退链同口径）——
                  // 此前 avatar 为 null 时一个都不高亮，看起来像"没头像"（R1 补充）。
                  const active = avatar
                    ? avatar === a.avatar_url
                    : i === 0
                  return (
                    <button
                      key={a.id}
                      type="button"
                      title={`用 ${a.platform} 的头像`}
                      className={`vd-avatar-opt${active ? ' on' : ''}`}
                      disabled={saving}
                      onClick={() => a.avatar_url && void pickAvatar(a.avatar_url)}
                    >
                      {/* R1（2026-09-13）：预览同样走 ProxyImage —— 裸 <img> 在
                          图床 403 时是破图/空白（实测 i0.hdslb.com 与 sinaimg 直连 403），
                          看上去就像"选中的是无头像默认图" */}
                      {src
                        ? <ProxyImage src={src} alt="" />
                        : <span>{a.platform}</span>}
                    </button>
                  )
                })}
                {avatarOptions.length === 0 && (
                  // 只有**一个账号都没加**（或账号都没有头像）时才回到默认头像
                  <span className="vd-hint">暂无账号头像，卡片显示名字首字占位</span>
                )}
              </div>
            </div>

            <div className="vd-section">
              <h4 className="vd-section-title">
                签名
                <span className="vd-hint">
                  {signHint}
                </span>
              </h4>
              <div className="vd-field">
                <span>签名</span>
                {/* 输入框 + **内嵌右端 chevron**（2026-09-13 设计案，devlog/072）：
                    点它展开候选面板；面板渲染在**弹窗内容体的直接子级**（滚动体之外）
                    且浮在下方内容之上 —— 定位与"为什么不做 portal"见 dialogRef 注释。
                    用途：卡片的签名只取主账号（B 站优先），想借微博那边的文案时不用手抄。 */}
                <div className="vd-sign-field" ref={signFieldRef}>
                  <input
                    value={sign}
                    onChange={(e) => setSign(e.target.value)}
                    onBlur={() => void commitSign()}
                    onKeyDown={onSignKeyDown}
                    placeholder="留空则由抓取回填"
                    role="combobox"
                    aria-expanded={signPopOpen}
                    aria-controls={SIGN_LIST_ID}
                    aria-activedescendant={signCursor != null
                      ? signOptionId(signOptions[signCursor]?.id) : undefined}
                  />
                  <button
                    type="button"
                    className="vd-sign-toggle"
                    title={signPopOpen ? '收起平台签名' : '选择其它平台的签名'}
                    aria-label={signPopOpen ? '收起平台签名' : '选择其它平台的签名'}
                    // 阻止默认：否则点它的瞬间输入框先失焦 → 触发一次"失焦即提交"
                    // （先写手打值、再被选中值覆盖 = 两次写库）
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSignPopOpen((o) => !o)}
                  >
                    <svg className={`vd-sign-chevron${signPopOpen ? ' on' : ''}`}
                         viewBox="0 0 16 16" aria-hidden>
                      <path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor"
                            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <div className="vd-section">
              <h4 className="vd-section-title">
                已订阅账号
                <span className="vd-hint">{vtuber?.accounts.length ?? 0} 个</span>
              </h4>
              <div className="vd-acc-list">
                {(vtuber?.accounts ?? []).map((a) => (
                  <div className="vd-acc" key={a.id}>
                    <span className="vd-acc-platform">{a.platform}</span>
                    <span className="vd-acc-name">
                      {a.display_name ?? a.platform_uid}
                      <em>{a.followers_count.toLocaleString('zh-CN')} 粉</em>
                    </span>
                    {/* R9（devlog/080）：曾用名/曾用签名归「账号信息历史」这一类，
                        用**独立弹窗**看 —— 不再混在编辑区里（2026-09-13 用户否掉的正是那种形态） */}
                    <button
                      type="button"
                      className="vd-acc-hist"
                      title="该账号的信息历史（曾用名/曾用签名 + 抓取快照）"
                      onClick={() => setHistTarget(a)}
                    >
                      <History className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="vd-acc-del"
                      title="删除该账号（连带清理其帖子与从属数据）"
                      onClick={() => setDelTarget(a)}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                <UserPlus className="size-4" />
                添加平台账号
              </Button>
            </div>
          </OverlayScroll>

          {/* 各平台签名候选面板（2026-09-13 第三次改版，devlog/075）：
              **弹窗内容体的直接子元素**（在 `.vd-settings-scroll` 之外）+ `position:absolute`：
              · 与内容体共享 radix 给的 `pointer-events:auto` ⇒ hover/点击可用（portal 到 body
                会被 radix 的 `body{pointer-events:none}` 静默吃掉，这正是用户报的"点不动"）；
              · 在内容体 DOM 内 ⇒ radix 不当它是"点了外面"，点行不会把整个弹窗关掉；
              · 不在滚动体盒子里 ⇒ 不会被 `overflow:hidden` 裁掉，也不必跟 `fixed` 的包含块较劲。
              坐标为内容体 padding box 相对值，由 placePanel 按输入条矩形算。 */}
          {signPopOpen && panelStyle && (
            <div className="vd-sign-panel" id={SIGN_LIST_ID} role="listbox"
                 aria-label="各平台签名" ref={signPanelRef} style={panelStyle}>
              {signOptions.length === 0 ? (
                <div className="vd-sign-empty">各账号都还没有签名</div>
              ) : (
                signOptions.map((o, i) => (
                  <SignOption
                    key={o.id}
                    option={o}
                    cursor={i === signCursor}
                    onPick={() => void pickSource(o.id)}
                  />
                ))
              )}
            </div>
          )}

          {/* 没有"保存/取消"了：改动**失焦即生效**（R1 补充，2026-09-13 用户：
              "修改要么实时生效要么全部都需要保存"）。只留一个关窗钮。 */}
          <div className="vd-settings-foot">
            {/* R21 批 3：页脚统一浮片（正文里那对「更换背景图 / 清除」是**行内动作**、
                不是页脚，按用户口径「右下角按钮」不动它们） */}
            <FloatPill size="md" shape="text" onClick={() => onOpenChange(false)}>
              关闭
            </FloatPill>
          </div>
        </DialogContent>
      </Dialog>

      <AddAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        vtuberId={vtuber?.id ?? null}
        vtuberName={vtuber?.name}
        onAdded={async () => {
          if (!vtuber) return
          onSaved(await api.getVtuber(vtuber.id))
        }}
      />

      {/* R9（devlog/080）：账号信息历史（曾用值 + 抓取快照）—— 独立弹窗，
          与编辑区解耦；数据来自 `/vtuber/{id}/former-values` 与 `/account/{id}/stat-snapshots` */}
      <AccountHistoryDialog
        open={histTarget !== null}
        onOpenChange={(o) => !o && setHistTarget(null)}
        vtuberId={vtuber?.id ?? null}
        account={histTarget}
      />

      <AlertDialog open={delTarget !== null} onOpenChange={(o) => !o && setDelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              解除 {delTarget?.platform} 账号「{delTarget?.display_name ?? delTarget?.platform_uid}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              该账号的帖子、直播场次与统计快照会一并清理，不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={removeAccount}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}