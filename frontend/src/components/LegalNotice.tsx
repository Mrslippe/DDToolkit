import { useEffect, useRef, useState } from 'react'
import FloatPill from './common/FloatPill'
import { api } from '../api/api'
import '../styles/legal-notice.css'

/**
 * **用户协议 / 免责声明闸门**（2026-10-06，用户口径）。
 *
 * > 「第一次启动应用或者更新至这个版本时，都要阅读一个用户协议或者公告，内容类似于这个应用的
 * > 功能简介和各类风险，并且使用带来的后果由用户承担，**阅读完同意才可以关闭窗口**」
 *
 * ## 四条实现口径（都对应用户那句话里的一个词）
 *
 * 1. **什么时候弹**：`GET /settings/agreement` 说 `needed=true` 就弹 —— 判定在后端
 *    （`services/legal_notice.py`：要同意的版本 = 应用版本，同意状态存 `app_meta`），
 *    所以**换版本就会再弹一次**、而"同意过"这件事跟数据目录一起走。
 * 2. **关不掉**：没有关闭钮、`Esc` 无效、点遮罩无效、也**没有第二个出口** ——
 *    唯一的出路是「我已知悉并同意」。要退就关整个应用窗口（下次启动还会弹）。
 * 3. **同意才继续**：`POST /settings/agreement` 成功后才放行；失败**如实说**并留在原地
 *    （后端不可达时也留在原地 —— 绝不"先放行再说"）。
 * 4. **挡住的是整个应用**（`fixed inset-0` + `z-index` 高于一切）：闸门之下什么都点不着。
 *
 * ⚠️ 正文**就是这个组件里的常量**（要排版、要能滚动，所以没做成后端下发）。改文案 = 改这里；
 * 用户若要"每次改正文都重新弹"，那就把要同意的版本从"应用版本"换成"正文哈希"
 * （`legal_notice.py` 末尾记了这条）。
 */

/** 正文（改它不需要动别处；**别把版本号写进来** —— 版本由后端给） */
const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: '一、这是什么',
    body: [
      'DDToolkit 是一个**跑在你自己电脑上的** VTuber 公开内容归档工具：按你填写的账号抓取'
      + 'B 站 / 微博 / 小红书 / 抖音上**公开可见**的动态与帖子，存进本机数据库并缓存图片，'
      + '方便你日后回看、检索、比对，不至于"平台删了/改了就再也找不回来"。',
      '它**不是**下载器、不是账号工具、也不替你发布任何内容：所有请求都用你在设置里自己配置的'
      + '登录凭据，以普通网页访问的方式发出。',
    ],
  },
  {
    title: '二、你的数据在本机',
    body: [
      '数据目录只在你自己的硬盘上（默认 `%APPDATA%\\DDToolkit`，可迁移到别的盘）：'
      + '数据库、图片缓存、日志、配置与 Cookie 全在里面，**不会上传到任何服务器**。'
      + '浏览器扩展与桌面应用之间的通信只走 `127.0.0.1`（本机回环），配对令牌也只存在本机。',
      '要彻底删除：删掉数据目录即可（应用不写注册表里的业务数据）。',
    ],
  },
  {
    title: '三、风险（请务必读完）',
    body: [
      '**① 平台规则风险**：B 站 / 微博 / 小红书 / 抖音的用户协议**均禁止**爬虫、自动化采集或'
      + '批量下载。本工具会带你的登录凭据访问它们的接口，**这可能违反平台协议**。',
      '**② 账号风险**：这类访问可能被平台的风控系统识别，后果包括但不限于：要求验证码、'
      + '限制访问频率、**限制或封禁账号**。工具内置了节流、退避与熔断来降低概率，'
      + '但**无法保证不会发生**。请优先使用你自己能够承受风险的小号。',
      '**③ 内容与版权**：抓下来的文字、图片、视频版权属于原作者与平台，仅供**个人留存与检索**；'
      + '不得再公开传播、二次分发或用于商业用途。',
      '**④ 第三方数据**：直播场次、粉丝数等第三方来源的数据可能与官方不一致，**仅供参考**；'
      + '本工具不保证任何数据的完整性、及时性或准确性。',
      '**⑤ 功能与更新**：平台接口随时可能改版，抓取可能失败或漏抓；应用按"现状"提供，'
      + '不承诺任何特定功能长期可用。',
    ],
  },
  {
    title: '四、责任自负',
    body: [
      '你理解并同意：**使用本工具及其带来的全部后果（包括账号受限、数据丢失、'
      + '与平台之间的争议等）由你自行承担**，作者不对上述后果负责。',
      '如果你不同意以上任何一条，请不要使用本工具（点下面的按钮同意后才能继续；'
      + '要退出，直接关闭应用窗口即可，下次启动还会显示这一页）。',
    ],
  },
]

interface Props {
  /** 后端报的"要同意的版本" */
  version: string
  /** 同意成功（父级据此放行） */
  onAccepted: () => void
}

/** 极简 `**加粗**` 渲染（正文常量里只有这一种标记；为它上 `dangerouslySetInnerHTML` 不值得） */
function rich(text: string) {
  return text.split('**').map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))
}

export default function LegalNotice({ version, onAccepted }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // 打开时把焦点收进来（键盘用户落在闸门上，而不是应用里那些点不着的控件上）
  useEffect(() => { cardRef.current?.focus() }, [])

  const agree = async () => {
    setBusy(true)
    setError(null)
    try {
      const got = await api.acceptAgreement(version)
      if (got?.needed === false) onAccepted()
      else setError('后端没有记下这次同意，请再试一次')
    } catch (e) {
      setError((e as Error)?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="legal-overlay" data-legal="1"
         /* ⚠️ 关不掉：Esc / 点遮罩 / 关窗钮**都没有**（用户口径"阅读完同意才可以关闭窗口"）。
            下面这三个 handler 只是把事件吃掉，免得穿透到应用里去。 */
         onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault() }}
         onClick={(e) => e.stopPropagation()}>
      <div className="legal-card" ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true"
           aria-labelledby="legal-title">
        <div className="legal-head">
          <h2 id="legal-title" className="legal-title">使用前请读一遍</h2>
          <span className="legal-version">v{version}</span>
        </div>
        <div className="legal-body">
          <p className="legal-lead">
            {rich('DDToolkit 是本地工具，但它抓的是**别人家的平台**。下面四段请读完再决定用不用。')}
          </p>
          {SECTIONS.map((s) => (
            <section key={s.title} className="legal-section">
              <h3 className="legal-section-title">{s.title}</h3>
              {s.body.map((p, i) => (
                <p key={i} className="legal-p">{rich(p)}</p>
              ))}
            </section>
          ))}
        </div>
        <div className="legal-foot">
          {error && <p className="legal-error" data-legal-error="1">没能记录同意：{error}</p>}
          <p className="legal-hint">
            同意后会记住这一版；下次换版本会再让你看一遍。
          </p>
          <FloatPill size="md" shape="text" data-testid="legal-agree"
                     disabled={busy} onClick={() => void agree()}>
            {busy ? '正在记录…' : '我已知悉并同意'}
          </FloatPill>
        </div>
      </div>
    </div>
  )
}
