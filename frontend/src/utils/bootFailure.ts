/**
 * 启动失败/迁移失败的**分类口径**（批次 16，devlog/207）。
 *
 * 为什么单独抽成纯函数：这两句文案要满足一条硬判据 ——
 * **只有"schema 迁移失败"才允许说"数据可以找回"**，端口占用 / 超时 / 后端崩溃
 * **不得**被误报成数据问题（误报会让用户去动数据目录，那才是真的丢数据）。
 * 文案写在 UI 里就只能靠肉眼复核，写在这里就能被 vitest 钉住。
 */

/** `/healthz` 里 `migration` 那一段（后端 `app/main.py::migration_state`） */
export interface HealthzMigration {
  status?: string
  label?: string
  error?: string
  /** 被隔离的坏库路径（`vtuber.db.failed-<时间戳>`）——"到哪儿找回"就是它 */
  quarantined?: string | null
  /** 迁移前的备份（`{path, bytes, wal_bytes}` 或 `{error}`） */
  backup?: { path?: string; error?: string } | null
  recovered?: boolean
}

export interface HealthzPayload {
  ok?: boolean
  version?: string
  first_run?: boolean
  migration?: HealthzMigration
}

export type BootFailureKind = 'migration-failed' | 'backend-unreachable'

export interface BootFailureCopy {
  kind: BootFailureKind
  title: string
  detail: string
  /** 后端没应答时**不能**提供"导出诊断"（那份东西要从后端取） */
  canExportDiagnostics: boolean
}

/**
 * 把启动失败分成两类。⚠️ **判据取"迁移状态"这个独立凭据**，不拿症状猜：
 * `/healthz` 说迁移失败 ⇒ 数据问题（可找回）；`/healthz` 根本没应答 ⇒ 不一定是数据问题。
 */
export function classifyBootFailure(
  health: HealthzPayload | null,
  bootError?: string | null,
): BootFailureCopy {
  const mig = health?.migration
  if (mig?.status === 'failed') {
    const where = mig.quarantined ? `被隔离在：${mig.quarantined}` : '旧库已被隔离（位置见日志）'
    const backup = mig.backup?.path
      ? `迁移前的备份：${mig.backup.path}`
      : '⚠️ 本次升级**没有**留下备份（备份失败：' + (mig.backup?.error ?? '未知原因') + '）'
    return {
      kind: 'migration-failed',
      title: '上次升级没有完成（数据没有丢）',
      detail:
        `升级时的数据库结构调整失败了，应用已用一本**新的空库**启动，所以你现在能正常使用。\n` +
        `${where}\n${backup}\n` +
        `请把数据目录整体保留好（不要删），并把这份诊断发给开发者。`,
      canExportDiagnostics: true,
    }
  }
  return {
    kind: 'backend-unreachable',
    title: '后端启动失败',
    detail:
      '内置后端服务未能在时限内就绪。**这不一定与数据有关** —— 端口被占用、杀毒软件首次扫描、' +
      '后端进程崩溃都会长成这样，所以先别动数据目录。\n' +
      '可以先把这份诊断信息发给开发者：' +
      (bootError ? `\n${bootError}` : '（见数据目录下的 logs/sidecar.log）'),
    canExportDiagnostics: false,
  }
}

/**
 * 启动成功、但迁移失败过 —— 给"应用内横幅"用的一小段文案（`null` = 什么都不显示）。
 *
 * ⚠️ 与 `classifyBootFailure` 的区别：这一条是"应用**能用**，但你要知道发生过什么"，
 * 所以它是**非阻塞**的（横幅），而不是启动幕上的错误页。
 */
export function migrationNotice(mig: HealthzMigration | undefined): {
  title: string
  detail: string
} | null {
  if (mig?.status !== 'failed') return null
  return {
    title: '上次升级没有完成（数据没有丢）',
    detail:
      '已用新的空库启动。' +
      (mig.quarantined ? `旧库被隔离在 ${mig.quarantined}` : '旧库已被隔离') +
      (mig.backup?.path ? `；迁移前的备份在 ${mig.backup.path}` : '；本次没有留下备份'),
  }
}
