import './../styles/layout.css'

/**
 * 顶栏：LOGO 占位 + 标题 + 状态区 + 装饰性窗口控制按钮。
 * 设计稿参照 other-sources/react Frame1672（粉色 #FFA2B4）。
 */
export default function TopBar() {
  return (
    <header className="topbar">
      {/* TODO(独立窗体阶段): LOGO 区域后续替换为图片 <img src="/logo.png" alt="logo" /> */}
      <div className="topbar-logo">D</div>
      <h1 className="topbar-title">DDtoolkit</h1>

      {/* TODO(抓取状态联动): 后端暴露 is_fetch_running 端点后，此处显示实时抓取状态 */}
      <span className="topbar-status">
        <i className="topbar-status-dot" />
        数据服务运行中
      </span>

      <div className="topbar-spacer" />

      {/* 独立窗体（Tauri/Electron）打包后接线：最小化/刷新/关闭 */}
      <div className="topbar-window-controls">
        <button className="topbar-win-btn" disabled title="最小化（桌面端可用）">
          —
        </button>
        <button
          className="topbar-win-btn"
          title="刷新"
          onClick={() => window.location.reload()}
        >
          ⟳
        </button>
        <button className="topbar-win-btn" disabled title="关闭（桌面端可用）">
          ✕
        </button>
      </div>
    </header>
  )
}
