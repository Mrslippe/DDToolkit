import { memo, useEffect, useState } from 'react'
import { api } from '../api/api'
import type { Account, ThirdpartyVtuber, VTuber } from '../api/types'
import AccountPicker from './AccountPicker'
import ProfileCard from './ProfileCard'
import OverlayScroll from './OverlayScroll'

interface Props {
  vtuber: VTuber
  /** fetch-idle 边沿：账号抓取完成后第三方索引自动刷新 */
  refreshTick: number
}

/** 档案卡专用账号选择（同 archive 卡片自治语义，B站优先默认） */
function useProfileAccount(vtuber: VTuber) {
  const accounts = vtuber.accounts.filter((a) => a.platform_uid)
  const defaultOf = (list: Account[]) =>
    list.find((a) => a.platform === 'bilibili' && a.platform_uid) ?? list[0] ?? null

  const [selected, setSelected] = useState<Account | null>(() => defaultOf(accounts))

  useEffect(() => {
    setSelected((prev) => {
      if (prev && accounts.some((a) => a.id === prev.id)) return prev
      return defaultOf(accounts)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vtuber.id])

  return { accounts, selected: selected ?? defaultOf(accounts), setSelected }
}

/**
 * 档案信息视图（P7 追加：档案卡移出到独立视图，v0.7.0）。
 * 专门展示 vtuber 详细设定相关信息——原 archive 视图移出的 ProfileCard
 * （企划/公会/生日/出道/房间/设定集），另补充：账号抽屉（各平台账号卡片）。
 */
const ProfileView = memo(function ProfileView({ vtuber, refreshTick }: Props) {
  const { accounts, selected, setSelected } = useProfileAccount(vtuber)
  const [thirdparty, setThirdparty] = useState<ThirdpartyVtuber[]>([])
  const [loadingTp, setLoadingTp] = useState(false)

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoadingTp(true)
    api.externalsVtuberByUid(selected.platform_uid)
      .then((tp) => !cancelled && setThirdparty(tp))
      .catch(() => !cancelled && setThirdparty([]))
      .finally(() => !cancelled && setLoadingTp(false))
    return () => { cancelled = true }
  }, [selected?.platform_uid, refreshTick])

  return (
    <OverlayScroll className="archive-view">
      <section className="archive-section">
        <div className="archive-section-head">
          <span className="archive-section-title">档案</span>
          <div className="archive-section-right">
            <span className="archive-section-note">
              {loadingTp ? '企划 / 公会 / 设定' : thirdparty.length > 0 ? `${thirdparty.length} 项第三方索引` : '企划 / 公会 / 设定'}
            </span>
            <AccountPicker accounts={accounts} value={selected} onChange={setSelected} />
          </div>
        </div>
        <OverlayScroll className="archive-section-scroll">
          <ProfileCard vtuber={vtuber} account={selected} thirdparty={thirdparty} />
        </OverlayScroll>
      </section>

      {/* 账号抽屉：该 V 的全部平台账号一览（头像 / 昵称 / 粉丝 / 房间号） */}
      <section className="archive-section">
        <div className="archive-section-head">
          <span className="archive-section-title">账号</span>
          <div className="archive-section-right">
            <span className="archive-section-note">{vtuber.accounts.length} 个账号</span>
          </div>
        </div>
        <OverlayScroll className="archive-section-scroll">
          <ul className="profile-account-list">
            {vtuber.accounts.map((a) => (
              <li key={a.id} className="profile-account-row">
                <span className={`acc-switch-platform${a.platform === 'bilibili' ? '' : ' weibo'}`}>
                  {a.platform === 'bilibili' ? 'B站' : a.platform === 'weibo' ? '微博' : a.platform}
                </span>
                <span className="profile-account-name">{a.display_name || a.platform_uid}</span>
                <span className="profile-account-meta">
                  {a.followers_count > 0 ? `${a.followers_count.toLocaleString()} 粉` : ''}
                  {a.room_id ? ` · 房间 ${a.room_id}` : ''}
                </span>
                {a.live_status === 1 && (
                  <span className="profile-account-live">直播中</span>
                )}
              </li>
            ))}
            {vtuber.accounts.length === 0 && (
              <li className="archive-empty">暂无账号</li>
            )}
          </ul>
        </OverlayScroll>
      </section>
    </OverlayScroll>
  )
})

export default ProfileView
