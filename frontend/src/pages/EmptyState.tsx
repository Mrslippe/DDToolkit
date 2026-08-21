import './../styles/layout.css'

/** 右栏空置界面：未选择 VTuber 时显示 */
export default function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state-card">
        <div className="empty-state-logo">D</div>
        <p className="empty-state-title">未选择 VTuber</p>
        <p className="empty-state-desc">在左侧列表中选择一位 VTuber，查看 TA 的帖子与投稿</p>
      </div>
    </div>
  )
}
