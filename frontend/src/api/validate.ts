/**
 * 关键响应的**运行时**形状校验（Q1，批次 13，devlog/216）。
 *
 * ## 为什么是手写而不是 zod / valibot
 * 计划里写的是"（zod / valibot）"，那只是**工具建议**。这里只校验**三个**响应
 * （列表 / 抓取状态 / 帖子分页），手写一共几十行、零新依赖；引一个运行时校验库会同时
 * 带来 `package-lock.json` 变更与冻结产物里的新包，而它换来的只是"同样的几十行"。
 * 真要长到十几个 schema 再换库——那时替换面就是这一个文件。
 *
 * ## 校验到什么程度
 * **只校验"界面真的读、且读错会静默出错"的字段**（`id`/`name`/`total`/`items`/三块状态），
 * 不做全字段穷举：多余字段一律放过（后端加字段是**兼容**变更，不该让前端报错），
 * 缺失/类型不对才抛。判据是"字段改名 ⇒ 当场报错并点名是哪个字段"，不是"结构完全一致"。
 */
import { ApiShapeError, describe } from './errors'

type Kind = 'number' | 'string' | 'boolean' | 'array' | 'object'

const isKind = (value: unknown, kind: Kind): boolean => {
  switch (kind) {
    case 'array': return Array.isArray(value)
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    default: return typeof value === kind
  }
}

function needObject(value: unknown, path: string, where: string): Record<string, unknown> {
  if (!isKind(value, 'object')) {
    throw new ApiShapeError(path, `${where} 该是对象，实际是 ${describe(value)}`, value)
  }
  return value as Record<string, unknown>
}

/** 逐字段要求存在且类型正确；`null` 视为**缺失**（后端 nullable 字段不该被当成有值）。 */
function needFields(obj: Record<string, unknown>, path: string, where: string,
                    fields: Record<string, Kind>): void {
  for (const [key, kind] of Object.entries(fields)) {
    const got = obj[key]
    if (got === undefined || got === null) {
      throw new ApiShapeError(path, `${where} 缺字段 \`${key}\`（或为 null）`, obj)
    }
    if (!isKind(got, kind)) {
      throw new ApiShapeError(
        path, `${where} 的 \`${key}\` 该是 ${kind}，实际是 ${describe(got)}`, obj)
    }
  }
}

// ── 三个关键响应 ────────────────────────────────────────────────────────

/** `GET /vtuber/list`：`VTuber[]`（含嵌套 accounts）。 */
export function validateVtuberList(value: unknown, path: string): unknown {
  if (!Array.isArray(value)) {
    throw new ApiShapeError(path, `该是数组，实际是 ${describe(value)}`, value)
  }
  value.forEach((item, i) => {
    const v = needObject(item, path, `第 ${i} 个 VTuber`)
    needFields(v, path, `第 ${i} 个 VTuber`, { id: 'number', name: 'string' })
  })
  return value
}

/** `GET /vtuber/{id}`：单个 `VTuber`。 */
export function validateVtuber(value: unknown, path: string): unknown {
  const v = needObject(value, path, 'VTuber')
  needFields(v, path, 'VTuber', { id: 'number', name: 'string' })
  return value
}

/** `GET /vtuber/fetch-status`：账号 / 帖子 / 外部三块状态（顶栏轮询的输入）。 */
export function validateFetchStatus(value: unknown, path: string): unknown {
  const top = needObject(value, path, 'fetch-status')
  needFields(top, path, 'fetch-status', {
    account: 'object', post: 'object', external: 'object',
  })
  // 这三个是"界面据此决策"的判据（不是因为它们好看）：
  // `manual_running` 决定按钮禁不禁用、`rate_limit`/`quiet_hours` 决定文案。
  needFields(top, path, 'fetch-status', {
    manual_running: 'boolean', rate_limit: 'object', quiet_hours: 'object',
  })
  return value
}

/** `GET /posts/{platform}/{uid}/paginated`：`PostPage`（分页靠 total/items，读错就静默少帖）。 */
export function validatePostPage(value: unknown, path: string): unknown {
  const page = needObject(value, path, 'PostPage')
  needFields(page, path, 'PostPage', { items: 'array', total: 'number' })
  return value
}
