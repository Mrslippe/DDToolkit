import { useEffect, useMemo, useRef, useState } from 'react'
import { api, resolveAsset } from '../../api/api'
import type { FanSearchHit } from '../../api/types'

interface Props {
  vtuber: string
  since: string
  until: string
  ids: string[]
  onPick: (uid: string) => void
}

/**
 * 名单搜索（2026-10-24）：按 uid / 昵称模糊搜**当前窗口池内**的人。
 *
 * 为什么放后端：前端只有已加载的 20 行，全池几千人不可能拉到本地再搜。
 * 输入 250ms 防抖；下拉最多 8 条。
 */
export default function MemberSearch({ vtuber, since, until, ids, onPick }: Props) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<FanSearchHit[]>([])
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const needle = q.trim()
    if (!needle) { setHits([]); return }
    let alive = true
    const t = window.setTimeout(() => {
      api.fanSearch(vtuber, needle, { since, until, ids, limit: 8 })
        .then((r) => { if (alive) { setHits(r.items); setOpen(true) } })
        .catch(() => { if (alive) setHits([]) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [q, vtuber, since, until, ids])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const shown = useMemo(() => hits.slice(0, 8), [hits])

  return (
    <div className="wb-search" ref={box}>
      <input
        className="wb-search-input"
        data-testid="ranked-search"
        placeholder="搜索 uid 或昵称"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => q.trim() && setOpen(true)}
      />
      {open && q.trim() && (
        <ul className="wb-search-pop" data-testid="ranked-search-pop">
          {shown.length === 0 ? (
            <li className="wb-search-empty">池内没有匹配的人</li>
          ) : shown.map((h) => (
            <li key={h.uid}>
              <button
                type="button"
                className="wb-search-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(h.uid); setOpen(false); setQ('') }}
              >
                <img className="wb-avatar" src={resolveAsset(h.avatar) ?? ''} alt=""
                     onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                <span className="wb-search-name">{(h.name || h.uid).slice(0, 14)}</span>
                <span className="wb-search-meta">{h.type} · {h.strength.toFixed(3)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
