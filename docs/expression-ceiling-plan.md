# 表现力天花板计划：从量化音符到可演奏、可炫技的 score

**状态：W1 与 W2.0-W2.2 已实施，W2.3-W2.5 和 W3 仍是提案。** 本文是路线图，不是线格式授权；W1 的 `offsetMs`、`~drag`/`~push`、`swingUnit` 和参数化 arp，以及 W2.0 compare、W2.1 `drumChoke`、W2.2 `~pan`/`~send` 已进入 `parse.ts` / `help.ts`。其余提案字段在落地前仍不得写进用户文档。`feel-timing-plan.md` 是 W1.1 的详细子计划；两者冲突时，W1.1 的字段语义以子计划为准。字段和范围最终由 `parse.ts` 与 `help.ts` 决定。

## 1. 问题：天花板不在音质

当前引擎已经能写鼓、段落、和弦、发音法、滤波、空间、混音和自检。真正卡住“顶级表达/炫技”的不是 44.1 kHz/16-bit，也不是 PICO-8 音色，而是 **score 目前只能写“第几步、什么音、哪个固定效果”**。

| 目标 | 现在能写 | 缺口 |
| --- | --- | --- |
| 有“人味”的 groove | 全局 `swing`、全局 `humanize` | 逐轨/逐音的推拖、逐轨 humanize |
| 三连音、复合拍 | 整数 `step`，`stepsPerBeat` 1-8 | 更高分辨率网格、tuplet |
| 自定义琶音、装饰音 | `arpfast`/`arpslow` 固定大三和弦 | 参数化 arp、trem/trill |
| 立体声炫技 | track/section `pan`/`width` | 逐音 pan/send |
| 音色设计 | chip、additive、FM 1-3 固定路由 | FM feedback、pitch envelope、多段包络 |
| 打击乐真实感 | 8 个合成鼓 + 采样替换 | choke、layered hits |
| 连续运动 | section filter `from→to`、track LFO、kick duck | 宏曲线、任意源 sidechain |
| 复杂和声 | 命名和弦最多 4 音 | 11/13/alt、voicing、voice leading |
| 变速变拍 | section 边界 `bpm` | 段内 tempo ramp、per-section meter |

## 2. 边界分类

| 类型 | 例子 | 处理 |
| --- | --- | --- |
| 预算型 | 32 轨、15 分钟、16 partials、8 音和弦、16 zones | 按需抬，不盲目；不是音乐上限 |
| 语义型 | 整数 step、固定 effect、全局 swing、4 音命名和弦、FM 固定路由、kick-only duck | 这是表达瓶颈，按波次拆 |
| 产品型 | 无总分、无自动混音、无表达式音源、无任意 DAW 自动化 | 保留 |

**保留的产品边界：**

- 确定性：所有随机必须由 `seed` 决定，同一 score 必须逐样本可复现。
- 无总分：报告只给测量、归因和 `next`，不做“好听分数”。
- 无自动混音/母带：插件给旋钮和读数，不替作者做审美决定。
- 无绝对秒：事件仍属于 pattern/step；不做 `at: 2.35`。
- 无表达式/公式音源：数据模型可以变深，但不把分数变成程序。
- 默认不输出逐帧热力图：上下文成本大于收益；按需 raw artifact。
- 不盲目抬预算：轨数、时长、partials 的 caps 是渲染成本，不是表达上限。

## 3. 原则

1. **默认中性。** 新字段缺省时不改变旧 score 的任何一个采样；dry/classic/hitech 的 golden hash 必须不变。
2. **只加可组合原语。** 一个字段只做一件事；不要在 `energy` 里偷偷加混响，也不要让 `swing` 自动改音色。
3. **共用调度函数。** 微时序、swing、humanize 的叠加只能有一份实现；melodic 和 drum 不能各写一套钳制。
4. **确定性。** 概率、ratchet、euclidean 都由 `seed` 决定；同一 pass 内变化，loop 每个 pass 逐样本一致。
5. **token 便宜。** 每个音写对象会耗尽上下文；优先 `~drag(15)`、`~arp(...)`、`E(5,16)` 这类紧凑写法，不引入 DAW 式 automation lane。
6. **可验证。** 每个新旋钮至少有一个报告读数或一个确定性测试；否则模型只能盲写。
7. **一次只开一个语义口。** 高分辨率网格、tempo ramp、per-section meter 都是会穿透 parser/timeline/report 的改动，必须单独成波，不和音色功能混在一起。

## 4. 波次总览

| 波次 | 内容 | 目标 | 成本 | 状态 |
| --- | --- | --- | --- | --- |
| W1 | 演奏层、节奏分辨率、参数化 arp | 让同一 pattern 听起来像人演奏，能写三连音和自定义音型 | 1-2 周 | 已实施 |
| W2 | 鼓 choke、逐音空间、FM/additive、宏曲线、生成器 | 打开音色、空间和运动 | 2-4 周 | W2.0-W2.2 已实施；W2.3-W2.5 提案 |
| W3 | 和声扩展、变速变拍、stems/cue | 打开和声与曲式，补齐输出形态 | 3-6 周 | 提案 |

---

## 5. W1：演奏层与节奏词汇

### W1.1 微时序与逐轨 feel

采用 [`feel-timing-plan.md`](./feel-timing-plan.md) 的 P0/P1，并补两个小扩展。

| 字段/后缀 | 范围 | 默认 | 作用 |
| --- | --- | --- | --- |
| `tracks[].offsetMs` | -200..200 | 0 | 整条轨前移/后移；正数晚，负数早 |
| `tracks[].swing` | -0.5..0.5 | 继承 score | 该轨覆盖 score 的 swing，不做相加 |
| `tracks[].humanize` | `{timingMs?, velocity?}` | 继承 score | 字段级覆盖：写了就替换，没写继承 |
| `~drag(ms)` | 0..200 | 0 | 单个 token 晚 |
| `~push(ms)` | 0..200 | 0 | 单个 token 早 |

语义：

- 顺序固定为 `step 起点 → swing → 轨道 offsetMs → token offsetMs → humanize`。
- 有效偏移 = `clamp(轨道偏移 + token 偏移, -0.49 × 本地一步, +0.49 × 本地一步)`，在 render 期按事件所在段落的 `stepSeconds` 计算。
- 钳制产生一条按轨道去重的 `timing-clamped` warning，并给出当前段落的半步上限。
- 只移 onset，不改 `event.step`、slot、gate、pattern 游标；事件整体移动，包络和 release 跟着走。
- loop 第 0 步的负偏移从圈尾进入；song 第一拍不能早于 0；段落边界可以被 offsets 轻微跨越，但报告仍按 step 归属。
- `structure` 忽略偏移；`p8_probe` 把偏移置 0，与它已经置 `swing: 0`、`humanize: 0` 的理由相同。
- `~drag`/`~push` 与一个 `~effect`、一个鼓效果、鼓参数、`@volume`、一个 `~name` 演奏法共存；两个 timing 后缀同时出现报错。
- 和弦 token 的偏移作用于所有声部；`retrograde` 跟着 token 走，`augment`/`diminish` 不缩放偏移。

验收：

- 不写任何新字段时，旧测试与 golden hash 全绿。
- `offsetMs: 20` 在 44.1 kHz 下正好移动 882 采样；`~drag(20)` 与 `~push(20)` 方向相反。
- 120 bpm / 4（半步 62.5 ms）写 `offsetMs: 200` 被钳到 61.25 ms，并产生一条 warning。
- loop 第 0 步 `-20 ms` 从圈尾进入，接缝无静音、无双击。
- 鼓轨的 duck 触发点随偏移移动；delay 回声时间不跟随单个事件。
- `structure` 读数不变；`p8_probe` 输出不变。

落点：`src/features/score/types.ts`、`parse.ts`、`src/features/render/synth.ts`、`help.ts`、README、技能、测试。

### W1.2 高分辨率网格

把“整数 step”从 8 步/拍放宽到 24 步/拍，并给 swing 一个明确的单位。它不引入分数 step，因此 pattern 重复、slot 推进、loop 接缝和 structure 读数都保持原语义。

| 项 | 现在 | 计划 |
| --- | --- | --- |
| `stepsPerBeat` | 1-8 | 1-24（48 作为后续选项，见未决问题） |
| `swingUnit` | 不存在 | 1..`stepsPerBeat`，必须整除 `stepsPerBeat`，默认 1 |
| `MAX_STEPS_PER_NOTE` | 64 | 2048（24 PPQN 下一小节长音 = 96 步，长 pad 需要更多） |
| `MAX_GATE_STEPS` | 256 | 4096 |

swing 语义：

```
group = floor(step / swingUnit)
若 group 为奇数，偏移 = swing × swingUnit × stepSeconds
```

`swingUnit: 1` 与旧行为逐样本一致。`stepsPerBeat: 24` 时：

| 音符 | 步数 |
| --- | --- |
| 16 分 | 6 |
| 8 分 | 12 |
| 三连 8 分 | 8 |
| 三连 16 分 | 4 |
| 32 分 | 3 |
| 32 分三连 | 2 |

于是 16 分和三连音可以在同一小节共存，不需要分数 step。5/7 连音不在这一版解决：24 PPQN 覆盖 2/3/4/6/8/12/24 分，真正的 5/7 需要 pattern 级 tuplet 块或更高网格，单独评估。

验收：

- `stepsPerBeat: 24` 下 16 分、三连 8 分、三连 16 分、32 分的 onset 落在预期采样。
- `swingUnit: 12` 在 24 PPQN 下给出 8 分 swing；`swingUnit: 1` 的旧 score 与基线逐字节一致。
- `swingUnit` 不整除 `stepsPerBeat` 时报错，避免 swing 组跨小节。
- 旧 score 的 golden hash 不变。
- 结构报告仍按 `beatsPerBar` 和 `bars` 分小节，密度读数按真实事件计数。

风险与文档：

- 24 PPQN 下手写每 32 分会很长；技能文档要求用命名 pattern、motif 和长音 token，不要求每个音都写出来。
- 不新增 `hires-grid` 警告；高分辨率本身不是错误，token 膨胀由技能指南约束。

落点：`parse.ts` 的 `stepsPerBeat` 范围与两个 step caps、`synth.ts` 的 `swingSeconds` 与新增 `swingUnit`、`help.ts`、README、技能、测试。

### W1.3 参数化琶音

现在 `arpfast`/`arpslow` 固定 `[0,4,7,12]`，只能做大三和弦。给它们加参数，不新增表达式语言。

| 写法 | 含义 |
| --- | --- |
| `~arpfast` | 历史行为：`[0,4,7,12]`，周期半步 |
| `~arpslow` | 历史行为：`[0,4,7,12]`，周期一步 |
| `~arpfast(0,4,7,11;0.25)` | 自定义半音列，周期 0.25 步 |
| `~arpslow(0,3,7,10;0.5)` | 自定义半音列，周期 0.5 步 |

- `;` 前是 1-8 个半音，每个 -24..24；`;` 后是周期，0.05-8 步。
- 没有 `;` 时保持旧行为；参数缺省时使用旧默认。
- 与 `@volume`、`~vib`、`~slide` 共存时，仍只允许一个 pitched effect；arp 参数属于该 effect。
- `~trem`/`~trill` 不放进 W1；它们需要新的 effect 名，等 arp 参数机制稳定后再加。

验收：

- `~arpfast(0,4,7,11;0.25)` 在预期时间产生四个频率，顺序与半音列一致。
- 无参数写法与旧 golden hash 逐字节一致。
- 非法半音数、空列表、周期越界都报错并指向 `p8_help`。
- `formatPatternToken(parsePatternToken(x)) === x` 对带 arp 参数的 token 成立（或按现有规范化规则成立）。

落点：`src/features/score/types.ts` 的 `EffectParams`、`parse.ts` 的 `parseEffectParams`/`formatEffectParams`、`synth.ts` 的 arp 分支、`help.ts`、技能、测试。

---

## 6. W2：音色、空间与运动

### W2.0 比较工具（先行，已实施）

在改音色之前先给模型一个“和上一版比”的能力。没有它，W2 的每个旋钮都只能盲调。

- `p8_music compare: true`：把上一次渲染的 analysis 缓存在工作区，返回 delta 表。
- `p8_analyze detail: "compare"`：接受两个 WAV，返回 delta 表。
- 不改任何 DSP；默认关闭；不新增总分。

验收：delta 与两次独立 summary 一致；默认单次渲染行为不变；raw artifact 可重新读取。

### W2.1 鼓 choke（已实施）

现在 open hat 不会被 closed hat 切断，crash 也不会互相让位。加一个 opt-in 的 choke 表：

```json
{"drumChoke": {"hat": ["openhat"], "crash": ["crash"]}}
```

- 键是触发 choke 的 voice，值是会被切断的 voice 列表。
- 只影响有长尾的 one-shot；切断时用 5-10 ms 淡出，避免 click。
- 默认空表，旧 score 逐样本不变。
- layered hits 暂不加：两条鼓轨已经能叠层；round-robin 也用现有 zone 力度层表达。等 choke 有真实失败样本再谈。

验收：hat 后 openhat 的尾音 RMS 明显下降；没有 choke 表时输出不变；loop 接缝处切断仍逐样本确定。

### W2.2 逐音空间（已实施）

先做 **逐音 send**，再做 **逐音 pan**，因为 send 总线已经是立体声，而逐音 pan 需要把 track buffer 从 mono 改成 stereo。

| 后缀 | 范围 | 默认 | 作用 |
| --- | --- | --- | --- |
| `~send(0..1)` | 0..1 | 轨道 send | 该音进入混响 send 的比例 |
| `~pan(-1..1)` | -1..1 | 轨道 pan | 该音的等功率声像；写了就覆盖轨道 pan |

- 逐音 send 可以先在 note 调度时把该音的一小份加到 track send bus，不改变干声。
- 逐音 pan 需要 stereo track buffer；track filter/EQ/delay/duck 要在左右两路一致处理，最后再叠加轨道 pan 的默认值。
- 和弦的每个 voice 可以有自己的 pan/send；不做 per-voice 的 automation。
- 默认不写时与旧输出逐字节一致。

验收：`~pan(-1)` 的音只出现在左声道；`~send(0)` 的音不进入混响；轨道级 pan/send 仍然作用于未写后缀的音；golden hash 不变。

### W2.3 FM 与 additive 的音色深度

分两步，先做反馈，再做逐算子包络。

**FM feedback**

- `instrument.feedback`，0..0.95，默认 0；上一采样的输出反馈进相位。
- 只在 `quality: "clean"` 下默认启用过采样/带限；`pico` 下保留原始路径并在 `p8_probe` 报告 alias 风险。
- 不做任意算子矩阵；固定路由的 1-3 个调制器仍是上限。

**FM per-operator envelope**

- 每个 modulator 可选 `envelope: {attack, decay, sustain, release}`，作用在 modulation index 上；不写时退回现在的 `indexDecay`。
- carrier 仍用 note envelope。

**Additive pitch envelope**

- `instrument.pitchEnvelope: {amount, attack, decay, sustain, release}`，`amount` 为半音，-24..24；默认不启用。
- 只改频率，不改 partial 的相对关系；适合 kick、pluck、bell 的音头。
- 多段振幅包络暂不做：现有 ADSR + 逐 partial 衰减已经覆盖大部分；等有明确的“两段衰减”失败样本再加。

验收：feedback 增加边带且 `p8_probe` 能报告 alias；feedback 0 与旧输出逐字节一致；per-op envelope 改变 index 的时间曲线而不改 carrier 包络；pitch envelope 让音头基频滑动，`p8_probe` 的 attack/decay 读数随之变化。

### W2.4 宏曲线与任意源 sidechain

不做通用 automation lane；只把已有的 `from→to` 约定扩展到更多宏，并让 duck 接受任意源。

| 字段 | 现在 | 扩展 |
| --- | --- | --- |
| section `energy` | 0-1 常数 | 也接受 `{from, to}`，段内线性 |
| section `space` | 0-2 常数 | 也接受 `{from, to}`，段内线性 |
| section `width` | 0-2 常数 | 也接受 `{from, to}`，段内线性 |
| section track `pan` | -1..1 常数 | 也接受 `{from, to}`，段内线性 |
| section track `send` | 0..1 常数 | 也接受 `{from, to}`，段内线性 |
| track/group `duck` | 0..1，kick 触发 | 也接受 `{source, depth, attack, release}`；`source` 是轨名或组名，默认 kick |

- 频率类仍用指数扫频（现有 `filter`），增益/声像/发送用线性；不新增 `curve` 字段。
- `source` 解析在 parse 期完成；找不到时报错。组作为 source 时用组内所有轨的命中。
- 默认常数与旧 score 逐样本一致。

验收：`energy: {from: 0.3, to: 1}` 的段落读数单调变化；`space`/`width` 曲线在 `tape` 降速后仍落在正确秒数；`duck.source` 指向 bass 时 kick 不再触发 duck；旧数值写法不变。

### W2.5 确定性生成器

probability / ratchet / euclidean 能打开 breakbeat、techno、IDM 的“活”感，但它们需要新的 token 语法，先单独做 mini-design，不在 W1 混入。

- 所有生成必须由 `seed` 决定；同一 seed 的 loop 每个 pass 逐样本一致。
- 生成发生在 `timelineOf` 展开期，render 仍只看到绝对事件。
- 语法候选：`~p(0.6)`、`~ratchet(3)`、`E(5,16)`；最终拼写由 mini-design 拍板。
- 报告要能读到生成后的真实 hit 数，不能让 `structure` 和实际音频不一致。

验收：同 seed 逐样本一致；换 seed 改变；概率 0/1 退化为休止/必发；ratchet 的 hit 数与报告一致；euclidean 的命中位置符合定义。

---

## 7. W3：和声、曲式与输出

### W3.1 和弦扩展与 voicing

- 新增 11/13/alt 质量：`m11`、`maj13`、`13`、`7b9`、`7#9`、`7b5`、`7#11`、`maj7#11` 等。
- 命名和弦的 4 音上限只对旧质量保持不变；新质量可以到 6 音，避免破坏已有 `Cmaj7` 的渲染。
- 斜杠低音规则要重新检查：超过 4 音时先丢五度、再丢根音的顺序仍然适用，但 11/13 需要保留 3、7、扩展音。
- `voicing` 只做预设（`close`、`open`、`drop2`、`spread`），不做自动 voice leading；voice leading 是单独的 opt-in，等有明确验收再谈。
- 显式 8 音 voicing 仍是逃生口；模型可以完全绕过命名和弦。

验收：旧和弦 golden hash 不变；新质量展开成预期 MIDI；斜杠低音不丢关键音；`structure` 的 pitch-class 读数正确。

### W3.2 Per-section meter 与 tempo ramp

- `arrangement[].beatsPerBar`：允许段落换拍号；`bars` 仍按该段拍号计算步数。
- `bpm` 先支持段内 `{from, to}` 的线性/指数变化，仅 song 模式；loop 仍单一 BPM。
- `secondsAtStep` 从线性映射变成积分；section `durationSeconds`、delay `follow`、structure 分小节、fill/riser 都要跟着改。
- 先做 per-section meter，再做 tempo ramp；两者不要同一个 PR。

验收：3/4 与 4/4 交替的段落总步数正确；tempo ramp 的段落时长与逐帧累计一致；delay 在 ramp 段落的回声时间可解释；旧 song 逐样本一致。

### W3.3 输出形态

- stems 分轨导出按 [`forms-and-exports.md`](./forms-and-exports.md) 的 app 契约实现；render 只提供每轨/每组/每条 send 的音频和元数据。
- `cue` 曲式（定长单次 + tail）单独实现，不改变 `loop`/`song` 的默认行为。
- 24-bit / 48 kHz、true-peak limiter 作为 opt-in；默认仍是 44.1 kHz/16-bit，旧输出不变。

验收：stems 的命名、目录、manifest 和临时文件清理符合 `forms-and-exports.md`；cue 未请求时 loop/song 逐字节不变；24-bit 只在显式请求时生效。

---

## 8. 兼容与验收

- 旧 score 不写新字段时，dry/classic/hitech 的 golden hash 不变；这是每个波次的硬门槛。
- 新字段只在作者显式写入时生效；不做风格预设的隐式默认值。
- 每个波次至少覆盖：解析范围/默认值、渲染落点或频谱、loop 接缝、song 起点、报告读数、golden hash。
- `structure` 对微时序忽略偏移；`p8_probe` 对微时序置 0。其他新功能如果改变符号时间线，必须在 `structure` 里有对应读数。
- 新旋钮必须能在报告里被验证：`timing-clamped`、段落读数、stems、`p8_probe` 的 alias/attack/decay 等。
- 文档同步顺序：`parse.ts` → `help.ts` → README → 技能 → `docs/features/*.md`。不要在技能里复制字段表。
- `bun run check` 全绿；新增测试不能用“非静音”代替特征断言。

## 9. 风险与取舍

- **token 预算**：24 PPQN 会让手写 pattern 变长；用命名 pattern、motif、长音 token 控制。不要为每个 32 分写一个对象。
- **CPU**：W1 的高分辨率本身不增加事件数；真正的成本在 FM feedback、per-note pan 和更多轨。先按 block 处理，避免逐样本分配。
- **alias**：FM feedback 容易折叠；`clean` 路径要过采样/带限，`p8_probe` 要报告 alias 风险。
- **模型滥用**：每个音拖 30 ms 会把节奏弄散。技能给上限和建议（|offset| ≤ 20 ms，只给需要强调的声部）；默认 0。
- **语义漂移**：`swingUnit` 必须整除 `stepsPerBeat`；`stepsPerBeat` 默认仍是 4；旧 score 的 swing 必须逐样本一致。
- **逐音 pan 的架构成本**：track buffer 从 mono 变 stereo 会碰到 filter/EQ/delay/duck；如果成本过高，先只做逐音 send，pan 延后。
- **分析盲点**：微时序不会进 `structure`；逐音 pan 不会进符号报告，只能看 L/R 能量和 stem 宽度。
- **复杂度**：每个波次都要写“不做什么”；否则功能会从“可组合原语”滑向 DAW。

## 10. 实施顺序与门槛

1. **W1.1 微时序**：风险最低、收益最直接；先落地 `offsetMs`/`~drag`/`~push`，再加 per-track `swing`/`humanize`。
2. **W1.2 高分辨率网格**：先做 24 PPQN + `swingUnit` + 提高两个 step caps；48 作为后续选项。
3. **W1.3 参数化 arp**：在 W1.1/W1.2 的调度稳定后加，避免同时改 parser 和 effect 参数。
4. **W2.0 compare**：在改音色前先让模型能比版本。
5. **W2.1 鼓 choke**、**W2.2 逐音 send/pan**、**W2.3 FM feedback/pitch envelope**、**W2.4 宏曲线/sidechain**、**W2.5 生成器**：按此顺序，先低风险再高成本。
6. **W3**：和声扩展 → per-section meter → tempo ramp → stems/cue/24-bit。

**如果只能做三件：** W1.1 微时序、W1.2 高分辨率网格、W1.3 参数化 arp。它们分别补“人味”“节奏词汇”“乐句炫技”，而且都不需要重写音频架构。

**第一个 PR 建议：** 只做 W1.1，改 `types.ts`/`parse.ts`/`synth.ts`/`help.ts`，补 `timing-clamped` warning 和 golden hash 测试。第二个 PR 做 W1.2，第三个做 W1.3。

## 11. 未决问题

1. `stepsPerBeat` 上限取 24 还是 48？24 覆盖三连音 + 32 分；48 覆盖 64 分，但 token 更长。先用真实 score 试 24。
2. `swingUnit` 是否强制整除 `stepsPerBeat`？本文倾向强制，避免 swing 组跨小节。
3. `tracks[].swing` 是覆盖 score，还是叠加？本文倾向覆盖；叠加会让“全局 swing + 轨道 swing”难以解释。
4. `tracks[].humanize` 是字段级合并还是整体替换？本文倾向字段级：写 `timingMs` 就只覆盖 timing，velocity 继承。
5. arp 参数用 `;` 分隔半音列和周期，还是拆成两个字段？本文倾向 `;`，但需要在 `parseEffectParams` 里新增语法。
6. 逐音 pan 是否值得把 track buffer 改成 stereo？如果 W2.2 的逐音 send 已经够用，pan 可以延后。
7. FM feedback 是否只在 `quality: "clean"` 下开放？本文倾向是；`pico` 下保留原始路径并报告 alias。
8. 鼓 choke 用顶层映射还是 token 后缀？本文倾向顶层映射，token 更短且不占后缀槽。
9. 宏曲线用线性还是指数？本文倾向：频率指数，增益/声像/发送线性。
10. probability/ratchet/euclidean 的语法和范围需要单独的 mini-design；不要在没有失败样本前拍板。
11. per-section meter 与 tempo ramp 的先后：本文倾向先 meter，再 ramp；两者都会穿透 `structure` 和 delay。

## 12. 不做

- 绝对秒事件 `at: 2.35`：破坏 pattern/loop/section/structure 语义。
- 通用 DAW automation lane：会膨胀 token，并让报告无法归因；只做白名单宏曲线。
- 总分/排行/自动混音：Goodhart。
- 表达式/公式音源：把分数变成程序。
- 非确定性随机：无法 A/B 迭代。
- 默认逐帧热力图：上下文成本。
- VST/外部插件宿主：产品会变成 DAW。
- 盲目抬 32 轨/15 分钟/16 partials：预算不是音乐。
- 用全局网格硬做 5/7 连音：需要 pattern 级 tuplet 或更高分辨率，单独评估。

## 13. 一句话

PICO-8 不是天花板；真正的天花板是 **score 只能写“第几步、什么音、哪个固定效果”**。先把“演奏”和“节奏词汇”补上，再谈音色、自动化和变速；和声扩展、stems 和 24-bit 属于第二、第三波。
