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

  useEffect(() => {
    if (!open || !vtuber) return
    setName(vtuber.name)
    setFaction(vtuber.faction ?? '')
    setBirthday(vtuber.birthday ?? '')
    setDebut(vtuber.debut_date ?? '')
    setSetting(vtuber.setting ?? '')
    setSign(hero?.sign ?? '')
    setAvatar(vtuber.avatar ?? null)
    setLocked(
      (hero?.locked_fields ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }, [open, vtuber, hero])

  const toggleLock = (field: string) => {
    setLocked((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    )
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

  const save = async () => {
    if (!vtuber || saving) return
    setSaving(true)
    try {
      const lockedFields = locked.join(',') || null
      await api.updateVtuber(vtuber.id, {
        name: name.trim() || vtuber.name,
        faction: faction.trim() || null,
        birthday: birthday.trim() || null,
        debut_date: debut.trim() || null,
        setting: setting.trim() || null,
        avatar,
      })
      // 签名与锁定都是账号级字段 → 写主账号
      if (hero && (sign !== (hero.sign ?? '') || lockedFields !== hero.locked_fields)) {
        await api.updateAccount(hero.id, {
          sign: sign.trim() || null,
          locked_fields: lockedFields,
        })
      }
      const fresh = await api.getVtuber(vtuber.id)
      onSaved(fresh)
      onPill?.('档案设置已保存')
      onOpenChange(false)
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

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
              <h4 className="vd-section-title">基本资料</h4>
              <label className="vd-field">
                <span>名称</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="vd-field">
                <span>企划 / 公会</span>
                <input
                  value={faction}
                  onChange={(e) => setFaction(e.target.value)}
                  placeholder="如：VirtuaReal"
                />
              </label>
              <div className="vd-field-row">
                <label className="vd-field">
                  <span>生日</span>
                  <input
                    value={birthday}
                    onChange={(e) => setBirthday(e.target.value)}
                    placeholder="MM-DD"
                  />
                </label>
                <label className="vd-field">
                  <span>出道日</span>
                  <input
                    value={debut}
                    onChange={(e) => setDebut(e.target.value)}
                    placeholder="YYYY-MM-DD"
                  />
                </label>
              </div>
              <label className="vd-field">
                <span>角色设定</span>
                <textarea
                  value={setting}
                  onChange={(e) => setSetting(e.target.value)}
                  rows={4}
                  placeholder="自由文本，展示在档案卡"
                />
              </label>
            </div>

            <div className="vd-section">
              <h4 className="vd-section-title">头像</h4>
              <div className="vd-avatar-row">
                {avatarOptions.map((a) => {
                  const src = resolveAsset(a.avatar_path) ?? a.avatar_url ?? undefined
                  const active = avatar === a.avatar_url
                  return (
                    <button
                      key={a.id}
                      type="button"
                      title={`用 ${a.platform} 的头像`}
                      className={`vd-avatar-opt${active ? ' on' : ''}`}
                      onClick={() => setAvatar(a.avatar_url)}
                    >
                      {src ? <img src={src} alt="" /> : <span>{a.platform}</span>}
                    </button>
                  )
                })}
                <Button variant="outline" size="sm" onClick={() => setAvatar(null)}>
                  用平台默认
                </Button>
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
                onClick={() => toggleLock('sign')}
              >
                {locked.includes('sign') ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                {locked.includes('sign') ? '抓取时不覆盖签名' : '抓取会覆盖我改的签名'}
              </button>
              <button
                type="button"
                className={`vd-lock${locked.includes('display_name') ? ' on' : ''}`}
                onClick={() => toggleLock('display_name')}
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

          <div className="vd-settings-foot">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" disabled={saving} onClick={save}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : '保存'}
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
