// @vitest-environment jsdom
/**
 * 按住右方向键试听 3×（2026-10-05 用户，`devlog/356`）。
 *
 * 用户口径：**按住超过 250ms ⇒ 3×，松手恢复原速**；**短按仍然快进 5 秒**
 * （右键原本就是 `seekBy(5)`）；显示**只在播放器里**给一枚角标，底栏倍速与持久化偏好都不动。
 *
 * ## 为什么用源码级判据（而不是把播放器渲起来按键盘）
 *
 * `VideoPlayer` 要 media 元素、MSE 内核、代理取流一堆前置才起得来（见同目录那几条
 * `VideoPlayer.*.test.tsx` 的重量级夹具）。而这条需求真正会**悄悄坏掉**的地方只有三处，
 * 全是**结构**：
 *  ① **`e.repeat`**：长按连发 keydown，不挡住就会不停重置定时器 ⇒ 3× 永远触发不了；
 *  ② **漂移纠正那条 interval 会写 `playbackRate = prefs.rate`** ⇒ 不改成有效倍速的话，
 *     按住不到一秒就被拉回原速（"按了没反应"）；
 *  ③ **不许写进 `playerPrefs`**：写进去底栏倍率会跟着变、下次打开还记得 3×
 *     （用户明确说"状态行不需要收到这些消息"）。
 * 三条都用静态判据钉住；键盘交互本身（按住→松手）由人在真机上验。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'VideoPlayer.tsx'), 'utf8')

/**
 * 取出某个函数体：给 `endAnchor` 就切到那里（**优先**），否则退回固定长度窗口。
 *
 * ⚠️ 结束锚点必须**真的存在**：2026-10-06 改键盘入口时把 `const onKey =` 重命名成
 * `const handleKey =`，旧写法的 `src.indexOf('const onKey =')` 返回 -1 ⇒ `slice(i, -1)`
 * 一路切到文件末尾，把**新加的** `handleKey`（里面确实有 `setPlayerPrefs`）也圈了进来
 * ⇒ ④ 当场假红。这类"尺子量错了范围"的坑本仓记过好几次，所以现在锚点找不到就直接失败。
 */
function body(anchor: string, endAnchor?: string, len = 1400): string {
  const i = src.indexOf(anchor)
  expect(i, `没找到 ${anchor}`).toBeGreaterThan(-1)
  if (!endAnchor) return src.slice(i, i + len)
  const j = src.indexOf(endAnchor, i)
  expect(j, `没找到结束锚点 ${endAnchor}（改名了？别用会漂的锚点）`).toBeGreaterThan(i)
  return src.slice(i, j)
}

describe('按住右方向键 = 3×（结构判据）', () => {
  it('① 长按的重复事件不许重置定时器（`e.repeat` 挡住）', () => {
    // ⚠️ 2026-10-06：键盘处理改由"指针移入"接管（`devlog/380`），函数名 `onKey` → `handleKey`，
    //    参数类型也从 `React.KeyboardEvent` 收成 `KeyLike`（`document` 上的原生监听共用一份实现）。
    const k = body('const handleKey = (e: KeyLike)', 'const handleKeyUp =')
    expect(k).toMatch(/ArrowRight[\s\S]{0,200}if \(e\.repeat\) return/)
    // 右键**不再**直接快进（快进搬到 keyup 那一侧，按短长决定）
    expect(k).not.toMatch(/ArrowRight'\) \{ e\.preventDefault\(\); seekBy\(5\)/)
  })

  it('② 松手才决定"快进"还是"恢复原速"（keyup 两侧都要接上）', () => {
    const up = body('const handleKeyUp = (e: KeyLike)', 'const keyRef =')
    expect(up).toContain("if (endHold() === 'tap') seekBy(5)")
    // 两个入口都要接 keyup：容器上的 React 事件 + `document` 上那对（指针移入时挂的那条路）
    expect(src).toContain('onKeyUp={handleKeyUp}')
    expect(src).toContain("document.addEventListener('keyup', up)")
  })

  it('③ 漂移纠正用的是**有效倍速**（否则按住不到一秒就被拉回原速）', () => {
    expect(src).toMatch(/driftAction\(a\.currentTime - v\.currentTime, rateRef\.current\)/)
    expect(src).not.toMatch(/driftAction\(a\.currentTime - v\.currentTime, prefs\.rate\)/)
  })

  it('④ 加速不许写进持久化偏好（底栏倍速与"下次打开"都不该变）', () => {
    // `applyEffectiveRate` 是按住这条链上唯一改倍速的地方：它只写**元素**，不碰 `playerPrefs`
    const apply = body('const applyEffectiveRate', 'const beginHold')
    expect(apply).toContain('v.playbackRate = rateRef.current')
    expect(apply).not.toContain('setPlayerPrefs')
    // 起表 / 松手那一段同样不许碰偏好（3× 是"按住临时听一下"，不是用户的偏好）
    const hold = body('const beginHold', 'const endHold')
    expect(hold).not.toContain('setPlayerPrefs')
  })

  it('⑤ 松手可能收不到 ⇒ 窗口级 keyup/blur 兜底（不许卡在 3×）', () => {
    const guard = body("if (!holdSpeed) return", undefined, 900)
    expect(guard).toContain("window.addEventListener('keyup'")
    expect(guard).toContain("window.addEventListener('blur'")
  })

  it('⑥ 角标只在播放器里显示，且带可测抓手', () => {
    expect(src).toMatch(/holdSpeed && \([\s\S]{0,200}className="vp-hold-rate"[\s\S]{0,120}data-hold-rate=/)
  })

  it('⑦ 键盘由"指针移入"接管（`devlog/380`）：document 那对监听受 `hovering || fs` 约束', () => {
    // 这条需求的反向侧：**不能**无条件挂 document 监听（否则指针在别处时方向键也被吞掉）
    expect(src).toContain('if (!hovering && !fs) return')
    expect(src).toContain("document.addEventListener('keydown', down)")
    // 打字时不抢
    expect(src).toContain("el.tagName === 'INPUT'")
  })
})
