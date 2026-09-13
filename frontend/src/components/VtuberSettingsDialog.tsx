import { useEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Loader2, Lock, LockOpen, Trash2, UserPlus } from 'lucide-react'
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
import { api, resolveAsset } from '../api/api'
import type { Account, VTuber } from '../api/types'
import AddAccountDialog from './AddAccountDialog'
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
 * 档案设置窗口（P8-B，2026-09-10 用户）：把原「更换图片」按钮扩展为一个窗口 ——
 * 背景 / 名称 / 企划 / 生日与出道日 / 设定 / 头像 / 签名 / 已订阅账号管理。
 *
 * 设计取舍：
 * - **草稿 + 保存**：改完点保存才提交（避免每次击键打接口）；
 * - 字段锁定（`accounts.locked_fields`）：昵称/签名/头像手动改过后可上锁，
 *   抓取时跳过锁定字段，不被平台值覆盖（见 scheduler._field_locked）；
 * - 头像只能选账号的**远端 URL**（`vtubers.avatar` 不走 resolveAsset，
 *   写本地相对路径会拼错前缀）；
 * - profile 视图（档案卡）已下线，企划/设定/账号一览的内容在这里承接。
 */
/**
 * 回车 = 主动失焦（失焦即提交，见 `commitFields`）—— 让"打完字敲回车"也能落地。
 */
function blurOnEnter(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    ;(e.target as HTMLElement).blur()
  }
}

export default function VtuberSettingsDialog({
  open,
  onOpenChange,
  vtuber,
  onSaved,
  onPill,
}: Props) {
  const [name, setName] = useState('')
  const [faction, setFaction] = useState('')
  const [birthday, setBirthday] = useState('')
  const [debut, setDebut] = useState('')
  const [setting, setSetting] = useState('')
  const [sign, setSign] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [locked, setLocked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<Account | null>(null)
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
   * 已保存值快照：**判断"这次失焦到底有没有改动"**（避免 tab 过一遍字段就打一堆 PUT），
   * 同时给 name 的空值兜底用（留空 = 保持原名，而不是把名字写空）。
   */
  const savedRef = useRef({ name: '', faction: '', birthday: '', debut: '', setting: '', sign: '' })
  useEffect(() => {
    if (!open || !vtuber) return
    const key = `${vtuber.id}:${hero?.id ?? ''}`
    if (seedRef.current === key) return
    seedRef.current = key
    const seed = {
      name: vtuber.name ?? '',
      faction: vtuber.faction ?? '',
      birthday: vtuber.birthday ?? '',
      debut: vtuber.debut_date ?? '',
      setting: vtuber.setting ?? '',
      sign: hero?.sign ?? '',
    }
    savedRef.current = seed
    setName(seed.name)
    setFaction(seed.faction)
    setBirthday(seed.birthday)
    setDebut(seed.debut)
    setSetting(seed.setting)
    setSign(seed.sign)
    setAvatar(vtuber.avatar ?? null)
    setLocked(
      (hero?.locked_fields ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
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
   * 字段锁定**点击即写入**（R1，2026-09-13）：同上，锁是个开关，
   * 让"锁了但没保存"变成不可能（此前它跟草稿一起提交，用户锁完直接关窗就丢了）。
   */
  const toggleLockNow = async (field: string) => {
    if (!hero || saving) return
    const prev = locked
    const next = prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    setLocked(next)                    // 乐观更新
    setSaving(true)
    try {
      await api.updateAccount(hero.id, { locked_fields: next.join(',') || null })
      // ⚠️ 必须回灌父级：本组件的播种键是「V id + 主账号 id」，光写库不刷新的话，
      // 关窗再打开会按**旧的** `hero.locked_fields` 重新播种 —— 于是刚锁上的又显示成未锁，
      // 正是 R1 反馈里"逻辑反过来了"的观感来源。
      onSaved(await api.getVtuber(vtuber!.id))
      onPill?.(next.includes(field) ? '已锁定：抓取不再覆盖' : '已解锁：抓取可覆盖')
    } catch (e) {
      setLocked(prev)                  // 失败回滚
      toast.error(`锁定状态保存失败：${(e as Error).message}`)
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

  /**
   * 文本字段**失焦即提交**（R1 补充，2026-09-13 用户：「修改要么实时生效，要么全部都需要保存」）。
   *
   * 选的是"全部实时"这一侧：本弹窗里已有三处即时写入（头像 / 锁定 / 背景），
   * 再留一个"保存"按钮就会长期存在"这条到底存没存"的歧义 —— 那正是 R1 反馈的来源。
   * 于是：
   * - 失焦（点别处 / Tab / 回车主动 blur）→ 提交**变化的**字段，一次账；
   * - 没有任何变化 → 不发请求（tab 过一遍字段不会打一串 PUT）；
   * - 提交后回灌父级（卡片/侧栏立即跟着变），失败则回滚输入框到已保存值并报错；
   * - 关闭按钮只负责关窗（没有"取消"语义了 —— 改了就生效）。
   *
   * ⚠️ 关窗时若焦点还在输入框里（Esc 关窗就是这条路径），DOM blur 不保证触发 →
   * 由卸载时的 flush 兜底（见下方 useEffect 与 `flushRef`）。
   */
  const commitFields = async (): Promise<void> => {
    if (!vtuber || saving) return
    const s = savedRef.current
    const next = {
      name: name.trim() || s.name,
      faction: faction.trim(),
      birthday: birthday.trim(),
      debut: debut.trim(),
      setting: setting.trim(),
      sign: sign.trim(),
    }
    const vtuberChanged =
      next.name !== s.name || next.faction !== s.faction || next.birthday !== s.birthday ||
      next.debut !== s.debut || next.setting !== s.setting
    const signChanged = !!hero && next.sign !== s.sign
    if (!vtuberChanged && !signChanged) return
    setSaving(true)
    try {
      if (vtuberChanged) {
        onSaved(await api.updateVtuber(vtuber.id, {
          name: next.name,
          faction: next.faction || null,
          birthday: next.birthday || null,
          debut_date: next.debut || null,
          setting: next.setting || null,
          avatar,
        }))
      }
      // 签名是账号级字段 → 写主账号
      if (signChanged) await api.updateAccount(hero!.id, { sign: next.sign || null })
      savedRef.current = next
      if (signChanged || vtuberChanged) onSaved(await api.getVtuber(vtuber.id))
      onPill?.('档案已更新')
    } catch (e) {
      // 回滚输入框到"最后一次成功保存"的值，不让界面撒谎
      setName(s.name); setFaction(s.faction); setBirthday(s.birthday)
      setDebut(s.debut); setSetting(s.setting); setSign(s.sign)
      toast.error(`保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  // 关窗兜底：Esc 关窗时输入框可能没触发 blur（焦点元素被卸载不派发 blur）
  const flushRef = useRef(commitFields)
  flushRef.current = commitFields
  useEffect(() => () => { void flushRef.current() }, [])

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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="vd-settings max-w-lg">
          <DialogHeader className="vd-settings-head">
            <DialogTitle>档案设置</DialogTitle>
            <DialogDescription>
              背景 / 名称 / 企划 / 设定 / 头像 / 签名与已订阅账号；带锁的字段不会被抓取覆盖。
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
                基本资料
                <span className="vd-hint">改完点别处即生效</span>
              </h4>
              <label className="vd-field">
                <span>名称</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => void commitFields()}
                  onKeyDown={blurOnEnter}
                />
              </label>
              <label className="vd-field">
                <span>企划 / 公会</span>
                <input
                  value={faction}
                  onChange={(e) => setFaction(e.target.value)}
                  onBlur={() => void commitFields()}
                  onKeyDown={blurOnEnter}
                  placeholder="如：VirtuaReal"
                />
              </label>
              <div className="vd-field-row">
                <label className="vd-field">
                  <span>生日</span>
                  <input
                    value={birthday}
                    onChange={(e) => setBirthday(e.target.value)}
                    onBlur={() => void commitFields()}
                    onKeyDown={blurOnEnter}
                    placeholder="MM-DD"
                  />
                </label>
                <label className="vd-field">
                  <span>出道日</span>
                  <input
                    value={debut}
                    onChange={(e) => setDebut(e.target.value)}
                    onBlur={() => void commitFields()}
                    onKeyDown={blurOnEnter}
                    placeholder="YYYY-MM-DD"
                  />
                </label>
              </div>
              <label className="vd-field">
                <span>角色设定</span>
                <textarea
                  value={setting}
                  onChange={(e) => setSetting(e.target.value)}
                  onBlur={() => void commitFields()}
                  rows={4}
                  placeholder="自由文本，展示在档案卡"
                />
              </label>
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
                  {hero ? `来自 ${hero.platform} 账号` : '暂无账号'}
                </span>
              </h4>
              <label className="vd-field">
                <span>签名</span>
                <input
                  value={sign}
                  onChange={(e) => setSign(e.target.value)}
                  placeholder="留空则由抓取回填"
                />
              </label>
              <button
                type="button"
                className={`vd-lock${locked.includes('sign') ? ' on' : ''}`}
                disabled={saving}
                title="点击即写入（无需等保存）"
                onClick={() => void toggleLockNow('sign')}
              >
                {locked.includes('sign') ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                {locked.includes('sign') ? '抓取时不覆盖签名' : '抓取会覆盖我改的签名'}
              </button>
              <button
                type="button"
                className={`vd-lock${locked.includes('display_name') ? ' on' : ''}`}
                disabled={saving}
                title="点击即写入（无需等保存）"
                onClick={() => void toggleLockNow('display_name')}
              >
                {locked.includes('display_name') ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                {locked.includes('display_name') ? '抓取时不覆盖账号昵称' : '抓取会覆盖账号昵称'}
              </button>
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

          {/* 没有"保存/取消"了：改动**失焦即生效**（R1 补充，2026-09-13 用户：
              "修改要么实时生效要么全部都需要保存"）。只留一个关窗钮。 */}
          <div className="vd-settings-foot">
            <Button size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
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
