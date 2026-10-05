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

/** 取出某个函数的函数体（从它的签名到下一个顶层 `const x = (` / `useEffect(` 之前） */
function body(anchor: string, len = 1400): string {
  const i = src.indexOf(anchor)
  expect(i, `没找到 ${anchor}`).toBeGreaterThan(-1)
  return src.slice(i, i + len)
}

describe('按住右方向键 = 3×（结构判据）', () => {
  it('① 长按的重复事件不许重置定时器（`e.repeat` 挡住）', () => {
    const k = body('const onKey = (e: React.KeyboardEvent)')
    expect(k).toMatch(/ArrowRight[\s\S]{0,200}if \(e\.repeat\) return/)
    // 右键**不再**直接快进（快进搬到 keyup 那一侧，按短长决定）
    expect(k).not.toMatch(/ArrowRight'\) \{ e\.preventDefault\(\); seekBy\(5\)/)
  })

  it('② 松手才决定"快进"还是"恢复原速"（`onKeyUp` + `endHold`）', () => {
    expect(src).toContain('onKeyUp={onKeyUp}')
    const up = body('const onKeyUp = (e: React.KeyboardEvent)')
    expect(up).toContain("if (endHold() === 'tap') seekBy(5)")
  })

  it('③ 漂移纠正用的是**有效倍速**（否则按住不到一秒就被拉回原速）', () => {
    expect(src).toMatch(/driftAction\(a\.currentTime - v\.currentTime, rateRef\.current\)/)
    expect(src).not.toMatch(/driftAction\(a\.currentTime - v\.currentTime, prefs\.rate\)/)
  })

  it('④ 加速不许写进持久化偏好（底栏倍速与"下次打开"都不该变）', () => {
    // `applyEffectiveRate` 是按住这条链上唯一改倍速的地方：它只写**元素**，不碰 `playerPrefs`
    const apply = src.slice(src.indexOf('const applyEffectiveRate'),
                            src.indexOf('const beginHold'))
    expect(apply).toContain('v.playbackRate = rateRef.current')
    expect(apply).not.toContain('setPlayerPrefs')
    // 起表 / 松手那一段同样不许碰偏好（3× 是"按住临时听一下"，不是用户的偏好）
    const hold = src.slice(src.indexOf('const beginHold'), src.indexOf('const onKey ='))
    expect(hold).not.toContain('setPlayerPrefs')
  })

  it('⑤ 松手可能收不到 ⇒ 窗口级 keyup/blur 兜底（不许卡在 3×）', () => {
    const guard = body("if (!holdSpeed) return", 900)
    expect(guard).toContain("window.addEventListener('keyup'")
    expect(guard).toContain("window.addEventListener('blur'")
  })

  it('⑥ 角标只在播放器里显示，且带可测抓手', () => {
    expect(src).toMatch(/holdSpeed && \([\s\S]{0,200}className="vp-hold-rate"[\s\S]{0,120}data-hold-rate=/)
  })
})
