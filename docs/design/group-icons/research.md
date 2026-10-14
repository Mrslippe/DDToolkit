---
doc: design/group-icons-research
class: snapshot
scope: 企划 LOGO 的来源调研：dd-center/vtbs.moe 与 vdb 里有没有现成素材、现成收集库（Wikimedia/百科/图标库/GitHub）各覆盖什么、各社规约对 LOGO 怎么规定，以及手工素材路线下的可用性分档
not-scope: 徽章怎么渲染与怎么退化成文字胶囊（真源 `frontend/src/utils/groupBadge.ts` + `docs/frontend/UI-MAP.md`）；素材清单本身（`frontend/src/assets/groups/WORKLIST.md`）
sot: frontend/src/utils/groupBadge.ts, frontend/src/assets/groups/WORKLIST.md
verified: 2026-10-14
---

# 企划 LOGO 来源调研（2026-10-14）

> 本文是**带日期的快照**，不是长期规格；复跑方法见 §8，所有数字都注明是实测值。
> 用途：`docs/TODO.md` §1「企划图标的素材」那一条的调研结论。
>
> **结论一句话**：**没有**任何现成的全量企划 LOGO 库。能随包分发的只有 Wikimedia Commons 上
> 少数日系品牌的 **PD-textlogo**（低于独创性门槛 ⇒ 无版权、只剩商标），
> 中国系企划**一个都没有** ⇒ 素材只能手工做（**用户 2026-10-14 拍板**）；
> 程序化来源（企划官方 B 站账号头像）实测可行、底数已量（§3/§4），但**未采纳**（§7）。

## 1. vtbs.moe 本体：没有 LOGO（已翻完整棵树）

`https://api.github.com/repos/dd-center/vtbs.moe/git/trees/master?recursive=1` 实测 **118 个条目**
（`truncated: false`），图片素材只有站点自己的东西：

| 路径 | 是什么 |
|---|---|
| `assets/ddpage.png` `assets/demo.png` `assets/mainpage.png` | 站点截图 |
| `src/assets/0.png` `1.png` `2.png` `logo.png` `face.jpg` | 站点自家图标与表情 |
| `public/favicon.ico` `favicon.svg` `repository-open-graph.psd` | PWA / 社交卡片 |

5 个子模块（`BiliChat`、`api/mock/Cluster-center`、`api/mock/DDatHome-nodejs`、`state-center`、
`src/assets/biliob-frontend`）也都是代码仓库。**企划 LOGO：0 张。**

⚠️ 它的 `LICENSE` 是 **MIT © 2019 simon3000** —— **只覆盖代码，不覆盖任何第三方商标图形**。
拿"vtbs.moe 是 MIT"当 LOGO 的使用依据是无效的（这是本项目最容易踩的一处误读）。

## 2. vdb 的 `list.json`：没有图片字段，但有「官方账号」

`https://vdb.vtbs.moe/json/list.json` 实测 HTTP 200 / **2,356,526 字节** / `application/json`：

- 结构 `{meta:{UUID_NAMESPACE, linkSyntax, timestamp}, vtbs:[…]}`；`vtbs` 实测 **10,133** 条。
- 类型分布：`vtuber` **9,898** / **`group` 221** / `fan` 13 / `misc` 1。
- 企划条目字段只有 7 个：`uuid` / `type` / `bot` / `name` / `group` / `group_name` / `accounts[]`，
  而 `accounts[]` 每项只有 `{id, type, platform}`，`type` 是 `official` / `relay`。
- **全量递归扫 `avatar|logo|image|img|icon|picture|pic|face|photo|thumbnail|cover|banner|head`
  这 13 个词形：字段 0 个、以图片扩展名结尾的值 0 个** ⇒ **vdb 不存任何图片**。
- 端点面很窄：`/json/list.json` 是唯一 200 的；`syntax/list` `group` `groups` `vdb` `index` `raw`
  `stats` `all` `deprecated` `vtbs` `group_name` `min` `name` 实测**全部 404**。

**但账号这一列是宝贝**：221 个企划里 **153 个至少有一个官方账号**，按平台
bilibili **147** / twitter 14 / youtube 7 / web 3 / other 2 / weibo・userlocal・youtubeAt・
twitch・booth・github・acfun 各 1。

## 3. 与 `WORKLIST.md` 对照：能对上多少

把 vdb 的 221 个企划（`name` 的 `cn`/`jp`/`en`/`extra` 全参与匹配，NFKC + 去空白符号后比较）
与 `WORKLIST.md` 的 212 行（211 个企划名 + 个人势）对了一遍：

| 指标 | 实测值 |
|---|---|
| 企划名能对上 vdb `group` | **187 / 212** |
| 其中带 **official** B 站账号 | **125** 个 |
| 按池内条数加权（有企划的 1,597 行） | 对上 **1,419 行 = 88.9%**；有官方账号 **1,109 行 = 69.4%** |

对不上的 24 个企划名（另有「个人势」本就不可能有）里，**11 个带「（北立交桥）」后缀**
（妖精管理局 / 冬日之家Ultra / 淬蜂计划 / 三光五色 / 猫猫祟祟 / 明月生肖 / 梦镜茶会 / 星界社 /
银潮project / 魅魔补习班 / 奥兹奇旅团）—— 那是 B 站侧的联合企划，vdb 里没有对应条目。
其余较大的缺口：`Vi-D` 30、`V_G研究所` 25、`WACTOR` 17、`狄灵计划` 10、`ENTUM` 6。

## 4. 未采纳路线的实测底数：官方账号头像 = LOGO

（本节记的是"如果走程序化抓取能拿到什么"，供以后重新评估；**本批不实现**。）

- 接口：`https://api.bilibili.com/x/web-interface/card?mid=<uid>&photo=false` → `data.card.face`，
  **免登录、免 wbi**。实测 133 次调用 **0 失败**（含真机库那 3 个企划）。
- **头像就是 LOGO，不是照片** —— 目视抽检 6 张全部成立：`VirtuaReal`(413748120) 的 VR 字标、
  `虚研社`(431412406) 蓝底圆标、`极光社`(8523)「AURORA」字标、`MZ次元`(402355190)「Marga zone」、
  `四禧丸子`(1129115529)「SIXIWANZI」、`EOE组合`(2018113152)「Elf of Era」。
- 映射质量：125 个里**昵称与企划名吻合 107 个**；不吻合 18 个中多数是**改名**
  （`Palette`→Epoch_Link、`雨林社`→Rain-Forest-Club、`Virtual放送部`→放送部Official、
  `yifun社`→艺方传媒），**少数是真错**：`C-Live_Project` → 「账号已注销」、
  `追光社` → 「约稿联系另一个号」、`MZ次元` → 「MZ小卖部」（周边店号）。
  ⇒ 真要用这张表，**必须人工过一遍 125 行**，不能照抄。
- 两个实现坑（真要做得先解决）：① 官方头像多是**不透明方图**（EOE 黑底、VirtuaReal/四禧丸子白底、
  虚研社蓝圆底），`object-fit: contain` 塞进 20×20 会显示成**色块**，得圆形裁切或抠底；
  ② hdslb 图片在应用 origin 下 **403**，只能走 `ProxyImage`（既有结论，见 `docs/backend/ASSETS.md`）。

## 5. 现成收集库盘点

### 5.1 Wikimedia Commons —— 唯一"协议干净"的一路 ⭐

`Category:Anime companies logos by VulcanSphere`（实测 66 个成员）与
`Category:Hololive Production logos`（实测 44 个成员）里有真货。**实测授权模板**：

| 文件 | 授权模板（wikitext 原文） | 含义 |
|---|---|---|
| `File:Hololive logo.svg` | `{{Licensed-TOO\|{{TOO-Japan}}\|{{PD-textlogo}}{{trademark}}}}` | 低于独创性门槛 ⇒ **无版权**，只剩商标 |
| `File:AnyColor logo.svg` | `{{PD-textlogo}}{{trademark}}{{TOO-Japan}}` | 同上 |
| `File:Nijisanji logo.svg` / `Nijisanji EN logo.svg` / `Nijisanji romaji logo.svg` | 同族（`Category:Nijisanji logos`） | 同上 |
| `File:VSPOlogo.png` `File:VShojo logo (original).svg` | 同族 | 同上 |
| `File:Hololive China logo.webp` | `{{cc-by-sa-4.0}}` | **有版权**，用要**署名 + 相同方式共享** |

还有 `Cover Corporation logo.svg`（含竖排与 2016–2019 旧版）、`Hololive ENGLISH/INDONESIA/
triangles/2026/Alternative`、`HOLOSTARS Logo.svg`、`HOLOSTARS ENGLISH Logo.svg`、`INNK Music logo.svg`。

**但它对我们名单的覆盖只有 3 个名字**：`Hololive`(35 行)、`NIJISANJI`(69)、`NIJISANJI EN`(16)
= 池内 **120 / 1,597 行 = 7.5%**（`774 inc` 在我们名单里，但 Commons 没有它的 LOGO）。
中国企划实测**全部没有**：`VirtuaReal` / `虚研社` / `A-SOUL` / `upd8` / `神椿` 搜过均为空。
⇒ **`PD-textlogo` 的版权风险为零，但商标权仍在**：它授权的是"复制这张图"，不是"当作你的标识使用"。

### 5.2 萌娘百科 / 萌娘共享 —— 不能当素材库

`Category:虚拟UP主Logo` 实测**是空分类**（"本分类目前不含有任何页面或媒体文件"）；
萌娘共享全站协议是 **CC BY-NC-SA 4.0**（页面页脚实测），**NC = 禁商业**，
且其图库里的 LOGO 多按"版权归原主"标注。**不采用。**

### 5.3 simple-icons（CC0）—— 无用

`https://cdn.simpleicons.org/<slug>` 实测：`hololive` / `nijisanji` / `anycolor` / `vspo` /
`holostars` / `upd8` **全部 HTTP 404**；只有平台图标存在（`bilibili` `niconico` `youtube` 均 200）。

### 5.4 GitHub —— 搜到的都是恶搞

`q=vtuber+logo` 命中 46 个仓库，前排全是「**Programming VTuber Logos**」这类
"把 VS Code / Terraform 画成二次元"的玩笑素材（`Aikoyori/ProgrammingVTuberLogos` 6.2k star、
`Ender-Wiggin2019/VTuber-Logos-Collection` 417 star、`alfonsusac/service-title-logo` 107 star），
**与企划本体无关**，且 license 多为 `NOASSERTION`。**没有**人做过企划 LOGO 合集。

### 5.5 官方素材包 —— 不存在

没有一家大社提供公开的 LOGO 下载页 / プレスキット。`virtuareal.com` 实测返回纯 JS 空壳，
没有任何素材下载或成文规约。

## 6. 规约：沉默 ≠ 授权

### 6.1 二创规约里根本没有「ロゴ」这两个字（逐字复核）

按 `ロゴ` / `商標` / `logo` / `trademark` 四个词形全文计数，**实测结果**：

| 页面 | `ロゴ` | `商標` | `logo` | `trademark` |
|---|---|---|---|---|
| `hololivepro.com/terms/`（Cover 二次創作ガイドライン） | **0** | **0** | **0** | **0** |
| `hololivepro.com/en/terms/`（EN Derivative Works Guidelines） | 0 | 0 | **0** | **0** |
| `holostars.hololivepro.com/guidelines/` | 0 | 0 | 0 | 0 |
| `anycolor.co.jp/guidelines/`（ANYCOLOR 二次創作ガイドライン） | **0** | **0** | 0 | 0 |

⇒ **"规约没提 LOGO" 不等于 "可以用 LOGO"**：这些规约管的是"二次创作"，
而**原样复制官方素材根本不算二次创作**，压根不落在规约的保护伞内。**沉默是缺口，不是许可。**

### 6.2 真写了 LOGO 的，全是限制（一手原文）

| 出处 | 原文（实测命中） | 含义 |
|---|---|---|
| ANYCOLOR 応援広告規程 | 「②「にじさんじ」公式ロゴ」 | **唯一**把官方 LOGO 列为"使用可能素材"的地方 —— 但它同时规定素材**由事务局发送**（「请勿使用从 SNS/网站获取的素材」）且**只能用于应援广告** |
| VSPO! `vspo.jp/guide/` | 「本ガイドラインは、一次創作コンテンツとしての公式画像(イラスト、**ロゴ等**)、動画、音声、楽曲等をそのまま、あるいは創作性のない単なる改変の域をでない形での利用を**一切許可しておりません**。」 | 点名 LOGO，**一切不许可**原样使用 |
| RIOT MUSIC `riot-music.com/guideline/` | 「当社は本プロジェクト公式画像（イラスト、**ロゴ等**）…をそのまま、あるいは創作性のない単なる改変の域をでないかたちでの利用を**一切許可しておりません**」 | 同上 |
| .LIVE / アップランド `appland.co.jp/guideline/` 第3条3項 | 「本キャラクターの提供にあたり、**商標、ロゴ及びサービスマーク等**…が表示される場合がありますが、当社は、利用者その他の第三者に対し**何ら商標等を譲渡し、又はその使用を許諾するものではありません**。」 | 明确**不授予**商标/LOGO 使用许可 |
| KAMITSUBAKI `kamitsubaki.jp/guidelines/` | `ロゴ` **0 次**、`商標` 1 次（「・上3つの**商標**」） | ⚠️ 只确认了"商标"被列进对象；**"ロゴ"在该页实测不存在**，别引用成它点名了 LOGO |

⇒ **没有任何一家明确允许**把 LOGO 用在第三方工具里；明确表态的四家（VSPO! / RIOT MUSIC /
.LIVE / ANYCOLOR 的应援广告规程）**全是限制**。

### 6.3 中国系企划：既无素材包，也无成文规约

`VirtuaReal` / `极光社` / `虚研社` / `问尘仙会` / `V_G研究所` / `猫邮社` 等**均未找到**任何公开
素材包或成文规约。取它们的官方账号头像，在性质上是**复制他人美术作品 + 使用他人商标**，
属于"未获许可但普遍存在"的用法 —— **风险自担，不能声称有授权**。

### 6.4 对本仓的含义

本仓是 **MIT 且带公开远端**（`github.com/Mrslippe/DDToolkit`）⇒ 把 LOGO **提交进仓库就等于再分发**，
`README.md` 的「许可与第三方声明」那节遮不住这件事。三条纪律：

1. **只随包 `PD-textlogo` 那几枚**（无版权），并在 `README.md` 的第三方声明里记明来源与商标归属；
2. **`cc-by-sa-4.0` 的（如 `Hololive China logo`）要署名 + 相同方式共享** —— 它会给整个仓库带来
   ShareAlike 约束，**默认不用**；
3. 其余一切（官方头像、百科图片、GitHub 上的素材）**一律不提交进仓库**；手工自制的图没有这个问题。

## 7. 决策（用户 2026-10-14 拍板）

**走手工素材路线**：自己出图丢进 `frontend/src/assets/groups/<slug>.svg`，**不做程序化抓取**。
理由（决策时的权衡，记下来免得以后重复论证）：

| 路线 | 覆盖 | 版权性质 | 结论 |
|---|---|---|---|
| **手工素材**（选定） | 想做多少做多少 | 自制 ⇒ **零风险**；风格可控 | ✅ 本批路线；不足部分**保持文字胶囊**（已是默认形态，不会坏） |
| 程序化抓官方账号头像 | 69.4% 有企划行数（§3） | 未获许可的复制 + 商标 | ❌ 本批不做；底数留在 §4 |
| 随包 Commons 的 PD-textlogo | 我们名单里 3 个名字（7.5%） | **无版权**，只剩商标 | ⭕ 可顺手做（§5.1 那几枚），不算在"手工"里也不违规 |

**手工素材的硬约束**（真源是 `UI-MAP.md` 与 `layout.css`，这里只列做图时要记住的）：

- 渲染位固定 **20×20 px**、`object-fit: contain` ⇒ 用**正方形画布**（`viewBox="0 0 64 64"` 起），
  主体占 85–90%，**实心块/粗描边**优先（20px 下细线会糊）。
- 只认 **`.svg` / `.png` / `.webp`**；`.jpg`/`.gif`/`.ico` 会被**静默忽略**（不报错，只是图标不出来）。
- 目前**只有浅色一套主题**（深色钩子留空，见 `tokens.css`）⇒ 纯白 LOGO 会看不见。
- `slug` 规则与边界（含 `ますかれーど` 折成空串、撞名 0 对）见 `WORKLIST.md` 的文末两查。

## 8. 怎么复核（复跑清单）

```powershell
# 1) vtbs.moe 文件树（看有没有图片目录）
#    https://api.github.com/repos/dd-center/vtbs.moe/git/trees/master?recursive=1
# 2) vdb：类型计数 + 图片字段全量递归扫 + 端点探测（一个脚本即可，勿把 2.3MB 灌进上下文）
#    https://vdb.vtbs.moe/json/list.json
# 3) 官方账号头像 → LOGO（免 wbi）
#    https://api.bilibili.com/x/web-interface/card?mid=<uid>&photo=false  → data.card.face
# 4) Commons：分类成员与授权模板
#    action=query&list=categorymembers&cmtitle=Category:Anime%20companies%20logos%20by%20VulcanSphere
#    action=query&prop=revisions&rvprop=content&rvslots=main&titles=File:<名字>
#    ⚠️ 连发会被限流（实测 HTTP 429）—— 每次之间留间隔，且 Wikimedia 要求带可识别 UA
# 5) simple-icons：https://cdn.simpleicons.org/<slug>（404 = 没有）
# 6) 规约：抓页面后按「ロゴ / 商標 / logo / trademark」四个词形计数（§6.1 的表就是这么来的）
```

⚠️ 两条实测坑：**web_fetch 抓 Commons API 会间歇性失败**（本地直连 + 自带 UA 更稳）；
**子代理的转述不能直接采信** —— 本批就纠出一处（§6.2 KAMITSUBAKI 那行）。
