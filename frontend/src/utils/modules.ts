/**
 * 可添加的应用模块注册表（2026-10-18）。
 *
 * 用户口径：「工具栏上半部分按钮的最下方有一个加号，点了弹窗选模块，选中确认后
 * 就出现在左侧工具栏，点它进模块」。
 *
 * 加一个新模块 = 这里加一行 + 一条路由。**不要**在 `IconRail` 里写死列表 ——
 * 那正是它之前只有三个硬编码入口的原因。
 */
export interface AppModule {
  /** 偏好键（后端 `PREFS` 同名）；`on` = 已添加 */
  key: string
  label: string
  /** 弹窗里的一句话说明 */
  desc: string
  /** 点入口去哪 */
  route: string
}

export const APP_MODULES: AppModule[] = [
  {
    key: 'fan_workbench',
    label: '数据分析工作台',
    desc: '选主播 + 时间区间，采集全量弹幕并算出粉丝结构（参与强度 / 类型 / 效标加权）。'
        + '数据存在本机，每个主播约几百 MB；首次采集需要几分钟。',
    route: '/workbench',
  },
]

/** 某个模块是否已添加（`on` 才算；`undefined`/`off` 都算没加）。 */
export function isModuleOn(values: Record<string, string>, key: string): boolean {
  return values[key] === 'on'
}

/** 已添加的模块（顺序同注册表）。 */
export function enabledModules(values: Record<string, string>): AppModule[] {
  return APP_MODULES.filter((m) => isModuleOn(values, m.key))
}
