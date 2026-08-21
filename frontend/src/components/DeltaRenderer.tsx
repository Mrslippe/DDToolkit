import { Fragment, type ReactNode } from 'react'
import type { DeltaOp } from '../api/types'
import { parseJson } from '../utils/format'

/**
 * B 站 Quill Delta 富文本渲染器（零依赖）
 *
 * 输入：{"ops":[{"insert":"text","attributes":{...}}, ...]}
 * 支持：header 1-3（标题）、align（对齐）、bold/italic/underline/strike/code、
 *       color/background、link、list（ordered/bullet）、blockquote、indent、\t 缩进
 */
interface Props {
  delta: string | DeltaOp[]
}

interface Block {
  inline: ReactNode[]
  attrs: Record<string, unknown>
}

const INLINE_ATTRS = new Set([
  'bold', 'italic', 'underline', 'strike', 'color', 'background',
  'link', 'code', 'font', 'size',
])

function renderInlineText(text: string, attrs: Record<string, unknown>): ReactNode {
  // \t 用全角空格保留缩进语义（white-space: pre-wrap 下普通空格也会保留）
  let node: ReactNode = text.replace(/\t/g, '\u3000\u3000')
  if (attrs.color || attrs.background) {
    node = (
      <span style={{ color: attrs.color as string, backgroundColor: attrs.background as string }}>
        {node}
      </span>
    )
  }
  if (attrs.code) node = <code>{node}</code>
  if (attrs.bold) node = <strong>{node}</strong>
  if (attrs.italic) node = <em>{node}</em>
  if (attrs.underline) node = <u>{node}</u>
  if (attrs.strike) node = <s>{node}</s>
  if (attrs.link) {
    const href = String(attrs.link)
    node = (
      <a href={href} target="_blank" rel="noreferrer">
        {node}
      </a>
    )
  }
  return node
}

function splitBlocks(ops: DeltaOp[]): Block[] {
  const blocks: Block[] = []
  let inline: ReactNode[] = []
  let pendingAttrs: Record<string, unknown> = {}

  const flush = (attrs: Record<string, unknown>) => {
    blocks.push({ inline, attrs: { ...pendingAttrs, ...attrs } })
    inline = []
    pendingAttrs = {}
  }

  for (const op of ops) {
    if (typeof op.insert !== 'string') continue
    const attrs = op.attributes ?? {}
    const parts = op.insert.split('\n')
    parts.forEach((part, i) => {
      if (part.length > 0) {
        // 行内格式属性（bold/link 等）只作用于当前文本段
        const inlineAttrs: Record<string, unknown> = {}
        for (const k of Object.keys(attrs)) {
          if (INLINE_ATTRS.has(k)) inlineAttrs[k] = attrs[k]
        }
        inline.push(renderInlineText(part, inlineAttrs))
      }
      if (i < parts.length - 1) {
        // 换行 = 块结束；块级属性（header/align/list/blockquote）挂在换行 op 上
        const blockAttrs: Record<string, unknown> = {}
        for (const k of Object.keys(attrs)) {
          if (!INLINE_ATTRS.has(k)) blockAttrs[k] = attrs[k]
        }
        flush(blockAttrs)
      }
    })
  }
  if (inline.length > 0) flush({})
  return blocks
}

function renderBlock(node: ReactNode, attrs: Record<string, unknown>): ReactNode {
  const align = attrs.align as string | undefined
  const style: React.CSSProperties = {
    textAlign: (align as React.CSSProperties['textAlign']) ?? undefined,
    paddingLeft: typeof attrs.indent === 'number' ? attrs.indent * 24 : undefined,
    marginBottom: '0.5em',
  }

  let content: ReactNode = node
  const header = attrs.header as number | undefined
  if (header === 1) content = <h1 style={style}>{content}</h1>
  else if (header === 2) content = <h2 style={style}>{content}</h2>
  else if (header === 3) content = <h3 style={style}>{content}</h3>
  else if (attrs.blockquote) content = <blockquote style={style}>{content}</blockquote>
  else if (attrs['code-block']) content = <pre style={style}><code>{content}</code></pre>

  return content
}

/** 按 list 属性把连续块分组为 <ol>/<ul> */
function renderWithLists(blocks: Block[]): ReactNode[] {
  const out: ReactNode[] = []
  let listType: string | null = null
  let items: ReactNode[] = []

  const closeList = (key: number) => {
    if (listType && items.length) {
      const itemsNode = items.map((it, i) => <li key={`${key}-${i}`}>{it}</li>)
      out.push(listType === 'ordered' ? <ol key={key}>{itemsNode}</ol> : <ul key={key}>{itemsNode}</ul>)
    }
    items = []
    listType = null
  }

  let key = 0
  for (const b of blocks) {
    const list = b.attrs.list as string | undefined
    if (list) {
      if (listType !== list) {
        closeList(key++)
        listType = list
      }
      items.push(renderBlock(b.inline, b.attrs))
    } else {
      closeList(key++)
      out.push(<Fragment key={key++}>{renderBlock(b.inline, b.attrs)}</Fragment>)
    }
  }
  closeList(key++)
  return out
}

/** Delta 渲染入口 */
export default function DeltaRenderer({ delta }: Props) {
  const parsed =
    typeof delta === 'string' ? parseJson<{ ops?: DeltaOp[] }>(delta, {}) : { ops: delta }
  const opsList = Array.isArray(parsed.ops) ? parsed.ops : []
  const blocks = splitBlocks(opsList)
  return (
    <div style={{ fontSize: 14, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>
      {renderWithLists(blocks)}
    </div>
  )
}
