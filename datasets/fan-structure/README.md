# datasets/fan-structure —— 粉丝结构分析的实测数据

> **这是数据产物，不是缓存。** 2026-10-17 从 `_probe/.cache/` 迁过来，因为上游会漂移
> （同一场几小时内 `total` 从 21,826 变 12,306），**删了就再也拿不回来**。

## 里面有什么

```
pilot_v3_mizuki/     弥月 75 场（2026-09-04 ~ 10-13）
pilot_v3_mingqian/   明前奶绿 75 场（2026-07-05 ~ 10-11）
  raw/<live_id>.json     逐人事实表（无损：尾巴不截、事件时间戳全留）
  names/<live_id>.json   {uid: 昵称}，按场存，能看出改名史
  stats/<live_id>.json   场次级元数据 + 对账结果（recon_v2 是权威字段）
curves/<live_id>.json   145 场逐分钟曲线（danmakus 算 + vtb chart/online）
ranked/<dir>.json       新输出模型的完整名单（参与强度 / 类型 / 类内名次 / 两个效标排序）
```

规模：**5,785,392 条记录 · 156 万人次 · 150 场**。`raw` + `names` 约 392 MB，已 gitignore。

## `raw` 的每用户字段

| 键 | 含义 |
|---|---|
| `m` / `mt` / `mh` | 弹幕条数 / 时间戳序列（毫秒）/ 文本哈希序列 |
| `e` / `et` | 入场条数 / 时间戳序列 |
| `p` / `pe` / `pt` / `pl` | 付费金额 / 笔数 / 时间戳 / 单笔金额序列 |
| `g` / `gd` / `sc` | 礼物 / 上舰 / SC 分项金额 |
| `t0` / `t1` | 该人在本场的最早 / 最晚事件 |

## 口径（都是实测结论，改动前先读 `docs/plans/fan-structure-analysis.md`）

- **danmakus 是真源**，`vtb.cat` 只作校验器。`vtb 独有 = 0`（逐条对齐验证过）
- **`vtb.cat` 是点状抽样**，有场次只覆盖 12% 的时间跨度 ⇒ **不能用它判我们的罪**
- **弃用只看内部判据**：150 场里只有 1 场被弃（08-27，仅 2 条记录）
- **入场事件并非每场都有**（明前奶绿 4/75）⇒ 出勤分析必须先过 `enter_present`
- **`end_at` 不是真实下播时刻**：33.1% 的场次尾部有 >60 分钟零弹幕（合计 219 小时）

## 怎么重算

```powershell
# 采集（会跳过已存在的文件，绝不覆盖）
python _probe/fan_pilot_v3.py --account 23 --sessions 75 --out pilot_v3_mizuki

# 逐分钟曲线
python _probe/fan_curves.py

# 模型输出（需要 numpy，用捆绑运行时）
& "$env:DSH_PYTHON" _probe/fan_output_model.py
```

脚本统一从 `_probe/_data_paths.py` 取 `DATA_ROOT`，不再硬编码 `.cache`。

## ⚠️ 不要做的事

- **不要覆盖 `raw/`** —— 上游会漂移，覆盖等于销毁证据
- **不要在采集时截断** —— 尾巴裁剪、去重、过滤全部是**分析期**的派生操作
- **不要因为"和 vtb.cat 对不上"就剔场次** —— 那是校验器不全，见
  `docs/plans/fan-structure-analysis.md` §2.4
