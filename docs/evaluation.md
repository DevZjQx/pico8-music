# 曲目评分维度

「表现力」不能只靠一个指标。每次改动应同时看下面六个维度，否则很容易把一个指标刷上去、把另一个刷下来。

## 维度与指标

| 维度 | 指标 | 用途 |
| --- | --- | --- |
| 频谱平衡 | 质心、sub/low/mid/high 占比 | 检查是否又变成 287 Hz 一团 |
| 瞬态/节奏 | onset/s、crest、每小节 hit 数 | 检查鼓和 groove |
| 空间 | side/mid、L/R 相关、尾音长度 | 检查干声宽度和 send |
| 和声/旋律 | pitch-class entropy、音程分布、重复率 | 检查是否随机游走或过度重复 |
| 结构 | 每段 RMS/质心/宽度/onset 密度 | 检查段落是否有起伏 |
| 响度/听感 | LUFS-I、LRA、sample peak（报告不做 true peak） | 检查成品度与长时间聆听的舒适度 |

频谱/质心来自最多 48 个 2048 样本帧（约 46 ms/帧）的抽样；宽度、峰值、RMS、LUFS 和 onset 密度使用全部样本。所有测量都包含母带和效果，不能直接等同干声编曲。

宽度是 side/mid RMS 比：0 是单声道，1 是硬声像。它没有上限，混响 `wet` 很高时可能超过 1；那说明左右声道之间存在反相或梳状关系，属于“相位上的宽”，不代表声场更稳定。看到 > 1 时应同时看 L/R 相关性和单声道兼容性。

M4 之后这些指标由 `p8_music` 的渲染报告自动给出（peak/RMS/LUFS/LRA、质心与五个频带、宽度、onset 密度、分段 RMS、警告），`p8_analyze` 可以对已有 WAV 重测；报告是测量，不是评分，主观判断仍然以上面的维度和盲听为准。

LRA（loudness range，EBU Tech 3342）用 3 秒短时响度、1 秒步进，经绝对 -70 LUFS 和相对 -20 LU 门限后取 10%–95% 分位差。它衡量“整首有没有强弱起伏”，不衡量“有没有留白”：静音段被绝对门限丢掉，所以有长休止的曲子 LRA 可以很小。报告因此同时保留分段 RMS，并在 `loudness-flat` 里要求段落电平差也小于 6 dB。

song 模式的每段读数现在同时给出 RMS、side/mid 宽度、频谱质心和 onset 密度（见 `space-energy-plan.md` 的 P0）。结构维度因此有两条独立的弧线：`flat-sections` 只看电平差（< 2 dB），`flat-space` 只在宽度跨度 < 0.08 且质心跨度 < 400 Hz 时提示。一段靠变宽/变亮而不靠变响的 drop 是合法写法，不应被当成“没有起伏”。

M2 之后可以用 `target` 声明一个 profile 或内联范围。报告不会给总分，只增加一条 `report target <name>: n/m checks in range`，并对每个越界维度给一条 `target` finding。目标仍然基于下面这些已有维度，所以偏差可以被解释；`soft` style 自带一组低阶 additive 乐器、clean 振荡器和较慢 attack，用来演示 profile 落在范围内。

M1 之后报告还包含可归因的诊断：`stems`（每条轨的 RMS/质心/频带/low-mid/pan/alias-risk）、`dry`（post 链之前的同口径测量）、`findings`（sub-heavy/mud/harsh/masking/alias-risk/dynamics 及 post 增量）。`p8_analyze` 的 `detail: "raw"` 会把完整分析写成同目录的 `*.analysis.json`，避免把逐项数据塞进上下文。设计与后续 M2/M3 见 [`analysis-roadmap.md`](./analysis-roadmap.md)。

## 测试策略

- 保留现有确定性测试。
- 新增「特征范围」测试（如 drum loop 的质心 > 2 kHz），不能只断言「非静音」。
- 对同一 score 做 dry vs post、drum on/off、sidechain on/off 的 A/B。

## 盲听清单

人工盲听 30 秒片段，重点听：

- 低频是否被 kick 和 bass 打架；
- 2 kHz 以上是否有信息；
- 段落边界是否成立。

## 与里程碑的关系

各里程碑的硬性验收标准（如 kick 的 body 基频 < 200 Hz、宽度 > 0.6、LUFS 在目标 ±1）写在 [`expressiveness-review.md`](./expressiveness-review.md) 的「里程碑与实现状态」一节；本文只定义看哪些维度、怎么测。

## 听感边界：提示与硬错误

报告分两层，故意不混在一起：

- **软提示**（`warnings`、`findings`）是建议，模型可以基于审美选择忽略。例如 `loud`（> -12 LUFS）、`loudness-flat`（LRA < 4 LU）、`harsh`、`mud`。它们回答“这样写会让人觉得怎样”，不是“这样写错了”。
- **硬错误**是安全边界，渲染直接失败。成品积分响度超过 -9 LUFS（`MAX_SAFE_LUFS`）时 `p8_music` 拒绝写文件。这个数字来自可审计的换算：在 K 系统校准的房间里，-20 dBFS 参考刻度约等于 83 dB SPL，立体声成品在参考音量下大致按 `SPL ≈ LUFS + 100` 播放；NIOSH 的 3 dB 等能量规则让 -9 LUFS 落在约 1 小时安全暴露附近。超过它的作品既没有动态余量，正常音量下的长时间聆听也不再安全。

`p8_analyze` 不执行这条硬错误：已有 WAV 无法通过分析变安静，能做的只有把 `unsafe` 报出来并给出可执行的下一步。安全上限只在“我们要生成一个文件”时生效。
