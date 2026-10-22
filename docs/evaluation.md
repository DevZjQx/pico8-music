# 曲目评分维度

「表现力」不能只靠一个指标。每次改动应同时看下面六个维度，否则很容易把一个指标刷上去、把另一个刷下来。

## 维度与指标

| 维度 | 指标 | 用途 |
| --- | --- | --- |
| 频谱平衡 | 质心、sub/low/mid/high 占比 | 检查是否又变成 287 Hz 一团 |
| 瞬态/节奏 | onset/s、crest、每小节 hit 数 | 检查鼓和 groove |
| 空间 | side/mid、L/R 相关、尾音长度 | 检查干声宽度和 send |
| 和声/旋律 | pitch-class entropy、音程分布、重复率 | 检查是否随机游走或过度重复 |
| 结构 | 每段 RMS/质心/宽度的对比度 | 检查段落是否有起伏 |
| 响度 | LUFS-I、sample peak（报告不做 true peak） | 检查成品度 |

频谱/质心来自最多 48 个 2048 样本帧（约 46 ms/帧）的抽样；宽度、峰值、RMS、LUFS 和 onset 密度使用全部样本。所有测量都包含母带和效果，不能直接等同干声编曲。

M4 之后这些指标由 `p8_music` 的渲染报告自动给出（peak/RMS/LUFS、质心与五个频带、宽度、onset 密度、分段 RMS、警告），`p8_analyze` 可以对已有 WAV 重测；报告是测量，不是评分，主观判断仍然以上面的维度和盲听为准。

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
