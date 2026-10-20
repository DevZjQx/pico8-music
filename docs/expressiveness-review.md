# 表现力审查：从「慢速混响循环」到可编曲的 PICO-8 声音引擎

分析对象：M1/M2 之前的 `pico8-music` 代码，以及一套仅作设计参照的本地参考素材（不随仓库分发）。

## 摘要

最大的限制不是合成器或混响质量，而是**作曲模型太小**，以及**后处理链被写死**。当时的工具只能写「一条单音 pattern 重复若干小节」，然后统一降速、低通、加混响，覆盖的是「慢速氛围循环」一个角落，无法表达参考素材里最常见的鼓、段落、和声、滑音、滤波运动、分层贝斯和转场。`slowed + reverb` 应该退化成一种可选 post preset，而不是产品本身。

**阅读约定：** 文中「分析时」指 M1/M2 之前的实现快照（第 3–4 节的主体），「现状」指本文更新时的实现状态（第 4 节的各项与第 7 节）。已实现的能力、当前测试和已知限制以第 7 节的状态段与 README 为准。

## 目录

1. [结论](#1-结论)
2. [文档范围与可信度](#2-文档范围与可信度)
3. [当时的引擎：能表达什么、渲染什么、听起来怎样](#3-当时的引擎能表达什么渲染什么听起来怎样)
4. [表现力缺口，按影响排序](#4-表现力缺口按影响排序)
5. [目标 score 形态](#5-目标-score-形态)
6. [架构调整](#6-架构调整)
7. [里程碑与实现状态](#7-里程碑与实现状态)
8. [一句话总结](#8-一句话总结)

---

## 1. 结论

- 当时最大的限制不是合成器或混响质量，而是**作曲模型太小**，以及**后处理链被写死**。
- 当时的工具只能写「一条单音 pattern 重复若干小节」，然后统一降速、低通、加混响。它覆盖的是「慢速氛围循环」一个角落，无法表达参考素材里最常见的鼓、段落、和声、滑音、滤波运动、分层贝斯和转场。
- `slowed + reverb` 应该退化成一种可选 post preset，而不是产品本身；这一点现在已通过 `post: []` 和可选的 `preset` 实现。
- 最高杠杆的五组能力是：**鼓、段落、gate/发音法、和弦与动机发展、滤波自动化**。
- 如果只能先做一个里程碑，选 M1（鼓 + 段落 + 干声），它改变的是产品类别；继续加波形或效果参数只是边际优化。

## 2. 文档范围与可信度

本文第 3–4 节的主体保留的是 M1/M2 之前的实现快照；其中「当前」「现在」除非特别标注，均指分析时状态。

- **素材不随仓库分发。** 第 3 节引用的示例渲染不在仓库里，相关数值无法从当前仓库复现，仅作为当时的分析记录。
- **这不是 benchmark。** 该示例只是当时一个 score 的临时产物。要严谨，应固定一组 score（无鼓/有鼓、干声/慢速混响）做矩阵对比，并区分「编曲差异」和「后处理差异」。
- **风格不是结论。** 参考素材是 hi-tech/fullon，不是要求插件变成该风格；它提供的是编曲词汇和声音设计参照。
- **统计口径。** 分析时用 4 秒窗统计；当前 `p8_music` 报告改为最多 48 个 2048 样本帧（约 46 ms/帧）的抽样，仍包含母带和效果，不能直接等同干声编曲。
- **结论是方向性的。** 分析时输出与参考的差距很大，但具体目标值应由风格 preset 决定，而不是统一追求「更亮更宽」。

## 3. 当时的引擎：能表达什么、渲染什么、听起来怎样

### 3.1 score 能表达什么

| 维度 | 分析时实现 | 直接后果 |
| --- | --- | --- |
| 音符 | 每轨单音；`steps` 同时是占位长度和发声门限 | 不能和弦、不能 legato/重叠；要短音只能插休止 |
| 轨道 | 最多 4 条；每条一个 pattern 循环填满 `bars` | 一个 4 音和弦就占满全部轨道；没有分层和编组 |
| 节奏 | 固定 grid，`stepsPerBeat` 1–8；无 swing | 不能三连、摇摆、微时序 |
| 力度 | 每音 `@volume` 0–7，只改振幅 | 力度不改变音色、滤波、包络 |
| 效果 | 7 个固定效果 | `slide` 固定 1 步；`vibrato` 固定 7.5 Hz / 0.5 半音；`arp` 固定大三和弦 |
| 包络 | 每轨一个 ADSR；release 在门限内 | 不能每音不同发音法，不能做长释放/踏板 |
| 音色 | 8 个 PICO-8 波形 | 没有鼓、没有滤波包络、没有 sub/layer |
| 空间 | 合成器是 mono；只有全局 Freeverb | 没有 per-track pan/send/delay |
| 动态 | 所有轨道求和后共用一个 peak ceiling | 没有压缩、sidechain、响度目标 |
| 形式 | 一个循环重复到 `minutes` | 没有 intro/build/drop/break/fill/outro |
| 后处理 | 强制 resample + lowpass + reverb | 不能出干声；`speed` 同时改速度和音高 |

### 3.2 render 链路

分析时 `render.ts` 的固定顺序（M1 之前）：

```
renderScore
  -> resample(speed)       // 降速且降调
  -> lowpass(toneHz)       // 全局一阶低通
  -> dcBlock
  -> reverb                // 全局 Freeverb
  -> copyWindow(第 3 圈)
  -> repeat(minutes)
  -> limitPeak
```

这意味着即使 `speed: 1`，输出仍然经过低通和混响；`preset` 只是调这几个参数，不是「是否使用后处理」的开关。`speed` 通过重采样同时改变 tempo 和 pitch，无法只变速度或只变音高。

### 3.3 输出的声音特征

对当时临时渲染的示例做同样口径的分析（44.1 kHz，4 秒窗，谱质心/频带能量/谱通量 onset/侧中比）：

| 指标 | 数值 |
| --- | --- |
| 时长 | 121.0 s |
| RMS | −17.0 dBFS |
| 峰值 | 0.686 |
| 谱质心 | 287 Hz |
| sub (20–60 Hz) | 0.2% |
| low (60–250 Hz) | 63.8% |
| mid (250–2k Hz) | 35.4% |
| high (2k–8k Hz) | 0.6% |
| air (8k–16k Hz) | 0.0% |
| 立体声宽度（side/mid RMS） | 0.54 |
| onset 密度 | 4.95 /s |

这不是在说「这个 loop 不好听」，而是说它的能量几乎全部压在 250 Hz 以下，2 kHz 以上几乎没有内容，瞬态密度也低。它听起来「糊」和「远」，并不完全是因为混响，而是因为**没有高频事件、没有鼓的瞬态、没有立体声干声**。这些数字的可复现性边界见第 2 节。

## 4. 表现力缺口，按影响排序

编号 P0 / P1 / P2 表示影响优先级，组内独立计数。每项按「当时限制 → 参考证据 → 设计建议 → 验收 → 现状」排列。

| 缺口 | 优先级 | 现状 |
| --- | --- | --- |
| [鼓与打击乐](#p0-1-鼓与打击乐) | P0 | 基础鼓已实现（M1），鼓效果未做 |
| [段落与编曲](#p0-2-段落与编曲) | P0 | 基础段落已实现（M1），fill/riser/tail/energy 未做 |
| [复音与和声](#p0-3-复音与和声) | P0 | 显式与命名和弦已实现，`voices`、`key`/`scale`、voice leading 未做 |
| [发音法、门限、动态](#p0-4-发音法门限动态) | P0 | slot/gate、命名包络、参数化 slide/vib 已实现；参数化 arp、力度映射未做 |
| [旋律、动机与乐句](#p0-5-旋律动机与乐句) | P0 | motif 引用与变换已实现，乐句级与和声进行未做 |
| [Groove、humanize、tuplet](#p1-1-groovehumanizetuplet) | P1 | swing 与 seed 已实现，humanize/tuplet 未做 |
| [滤波、自动化、sidechain](#p1-2-滤波自动化sidechain) | P1 | 部分实现（M3） |
| [分层、立体声、空间](#p1-3-分层立体声空间) | P1 | pan/send/delay 已实现，unison 与 bus 未做 |
| [转场 FX](#p1-4-转场-fx) | P1 | 用段落滤波扫频近似，独立 FX 事件未做 |
| [Mix / master](#p2-1-mix--master) | P2 | 已实现（M4）：tilt/saturate/compress/loudness/limiter |
| [让模型「听见」结果](#p2-2-让模型听见结果) | P2 | 已实现（M4）：渲染报告 + `p8_analyze` |

### P0：不做就无法表达参考素材的基本形态

#### P0-1 鼓与打击乐

**当时限制：** 只有 `noise` 波形，没有 kick/snare/hat/clap 的瞬态设计；也没有鼓的力度、roll、flam、ghost。

**参考证据：** 37 个 drum loop，20 kick，20 snare，17 clap，22 hat，12 kick roll，30 fill；drum loop 的谱质心 4.1 kHz、high 0.36、onset 10.5/s。

**设计建议：**

- 新增 `role: "drums"` 或 `instrument: "kick" | "snare" | "hat" | "openhat" | "clap" | "tom" | "rim" | "crash"`。
- token 直接用鼓名：`K:1 -:1 S:1 -:1 K:1 K:1 S:1 H:1`。
- 每个 hit 支持 `@v`、`~roll4`、`~flam`、`~ghost`、`~pitch`、`~decay`。
- 合成方案：
  - kick：正弦 + 指数 pitch drop（约 150→45 Hz）+ 短 click；
  - snare：180 Hz 体音 + 高通噪声；
  - hat：高通噪声 + 20–80 ms 衰减；
  - clap：3 个错开的噪声 burst；
  - crash：长高通噪声 + 慢衰减。
- 落点：`features/render/drums.ts`；score 只负责识别鼓 token。

**验收：** kick 的 body 基频 < 200 Hz，snare 的谱质心高于 kick，hat 高于 snare；pattern 的 hit 数与 onset 数一致；roll/flam 不产生 click。

**现状：基础鼓已实现（M1）。** 8 个合成鼓 voice、`K/S/H/O/C/T/R/X` token、`@力度`、one-shot 尾音重叠已落地；`~roll4` / `~flam` / `~ghost` 等鼓效果尚未实现。

#### P0-2 段落与编曲

**当时限制：** 一条 pattern 循环到 `minutes`，没有段落、mute、fill、转场。

**参考证据：** demosong 约 15 次段落变化；素材里有 30 fill、10 rise、22 sweep、11 impact、11 boom、20 zap。

**设计建议：**

- score 增加 `sections` / `arrangement`，每个 section 指定 `bars`、`patterns`、`mute`、`gain`、`filter`、`fill`、`riser`。
- 渲染器按 section 拼接；`mode: "loop"` 保留现有行为，`mode: "song"` 渲染完整结构。
- section 级别支持 `energy`（0–1）作为 gain/filter/send 的宏。

**验收：** 段落边界采样级精确；mute/unmute 正确；总小节数正确；loop 模式与旧 score 完全兼容。

**现状：基础段落已实现（M1）。** section 支持 `bars`、`patterns`、`mute`、`gain`/`gains`、`filter`；`fill`/`riser`/`tail` 和 `energy` 宏尚未实现。

#### P0-3 复音与和声

**当时限制：** 每轨单音，4 轨上限。一个 4 音和弦就占满全部轨道，无法同时有鼓、贝斯、和弦、lead。

**参考证据：** synth loops 里有 chords/strings/stabs；文件名大量标注调性（F、F#、Cm、Bm）；demosong 的 mid 频段占比 0.35。

**设计建议：**

- 每轨增加 `voices: 1–4`，或支持 chord token：`[C4,E4,G4]:8`、`C4maj7:8`。
- 增加 `key` / `scale`，可选的 chord 展开和简单 voice leading；模型只写和弦符号，引擎负责 voicing。
- 保留 `pico` 模式（4 轨、8 波形）作为风格约束；新增 `studio` 模式允许更多轨道/voice。
- 复音需要每 voice 独立 phase/envelope，不能共用 track 的单个 `phase`。

**验收：** 三和弦渲染出三个预期基频峰；voice stealing 不产生 click；和弦轨与鼓/贝斯轨可同时存在。

**现状：显式和弦与命名和弦已实现。** `[C4,E4,G4]:4` 展开成同一 step 的三个 `NoteEvent`，每个声部独立振荡器和包络；最多 4 个音。命名和弦（`Cmaj7`、`Fm/E`、`{C7}`）与斜杠低音在解析期展开成 midi，渲染路径与显式写法完全一致。`voices` 字段、`key`/`scale`、voice leading 和 `studio` 模式暂不做。

#### P0-4 发音法、门限、动态

**当时限制：** `steps` 同时决定「下一个事件从哪开始」和「这个音发声多久」；`release` 在门限内；`@volume` 只改振幅。

**参考证据：** bass 是 16 分短音 + 滑音 + 八度跳；32 个 ghost note；47 个 wet 版本；synth 有 stab/pluck/pad 不同发音。

**设计建议：**

- 把 slot 和 gate 分开：`C4:4g2` 表示占 4 步、发声 2 步；`C4:4g6` 表示发声跨过下一个 slot（legato/overlap）。
- 每音可覆盖 ADSR，或使用 `~staccato`、`~legato`、`~accent`、`~ghost`。
- 力度不再只乘振幅：映射到 filter cutoff、decay、drive，至少让 `@v` 改变音色。
- 效果参数化：
  - `~slide:80ms:ease`；
  - `~vibrato:5.5Hz:25c:120ms`；
  - `~drop:12st`；
  - `~arp:0,3,7,12:1/16`。
- 支持 tie/延音：`C4:4~` 或 `C4:4g8`。

**验收：** gate 变短会降低 RMS 但不改变事件起点；slide 在指定时间内到达目标音高；vibrato 的 rate/depth 可测量；ghost note 的频谱重心低于正常 hit。

**现状：slot/gate 分离与 per-note ADSR 已实现。** `C4:4g2` / `C4:4g6` 分别覆盖 staccato 和 legato；音高和事件起点不变。顶层 `envelopes` + `~pluck` 提供命名 per-note ADSR；`~slide(steps)`（0.05–8）与 `~vib(depth[,rate])`（0–2 半音，0.1–20 Hz）已参数化，无参数时行为与旧版一致。仍不做：参数化 arp（只有固定的 `arpfast` / `arpslow`）、力度映射到滤波/衰减——`@力度` 仍然只乘振幅。

#### P0-5 旋律、动机与乐句

**当时限制：** pattern 是一串扁平 token；模型要写变化只能把整段重新打一遍。没有「动机 A → 移位/倒影/逆行/扩值」的复用，也没有乐句的问答结构。

**参考证据：** demosong 的 lead/vocal hook 反复出现但每次有变化；58 个 vocal/shout 里有大量短动机；4 小节 synth loop 常见前半句提问、后半句回答。

**设计建议：**

- score 增加 `motifs` / `phrases`，pattern 可以引用并变换：`"lead": "@A @A.transpose(2) @A.invert @A.retrograde"`。
- 支持变换：`transpose`（半音/音级）、`invert`、`retrograde`、`augment` / `diminish`（时值）、`sequence`（按音程模进）、`ornament`（加装饰音）。
- 乐句级：`call` / `response`、`repeat` + `variation`、`cadence`；与 `sections` 结合，形成 4/8 小节问答。
- 和声：`key` / `scale` + chord symbols；允许罗马数字进行（如 `i - VI - III - VII`）和简单 voice leading。
- 这些都在 score 层做符号展开，不进入 DSP；渲染器仍然只看到绝对 step/midi 事件。

**验收：** 变换后的音高/时值符合定义；同一 motif 的引用不增加渲染成本；模型用更少 token 写出 AABA/问答结构。

**现状：motif 引用与 `transpose` / `invert` / `retrograde` / `augment` / `diminish` 已实现。** 乐句级 call/response、`sequence`/`ornament`、和声进行与 voice leading 暂不做。

### P1：决定「像不像成品」的表现力

#### P1-1 Groove、humanize、tuplet

**当时限制：** 完全量化；`stepsPerBeat` 最大 8，不能三连；没有 swing。

**参考证据：** reference 是 machine-tight，但有大量 ghost note 和 16 分滚动；drum loop onset 10.5/s。

**设计建议：**

- `swing: 0–0.5`（奇数 16 分延后比例）。
- `humanize: { timing: ms, velocity: 0–1 }` + `seed`，保证可复现。
- `grid: 12` 或 `24` 支持三连/复合拍；或 `stepsPerBeat` 放宽到 12/24。
- `probability` / `ratchet` 可选，但必须 deterministic。

**验收：** swing 后奇数 16 分偏移可测量；同一 seed 渲染完全一致；三连 pattern 的总步数正确。

**现状：swing 与 seed 已实现。** `swing: 0–0.5` 延后奇数 step，渲染确定；`seed` 只影响 noise 波形与鼓的噪声瞬态，用来生成同谱变体。humanize、tuplet、probability/ratchet 暂不做：humanize 必须是 `(step, voice)` 的确定性函数并在 loop 上回绕，否则会破坏无缝循环；tuplet 需要分数 step 网格，成本远高于收益。

#### P1-2 滤波、自动化、sidechain

**当时限制：** 只有全局一阶低通；没有 per-track filter、没有 resonance、没有 envelope/LFO、没有 sidechain。

**参考证据：** 15 个 acid loop；bass 的 filter 变化；riser/sweep 依赖滤波运动；fullon 的 kick/bass ducking。

**设计建议：**

- 每轨 `filter: { type: "lowpass" | "highpass" | "bandpass", cutoff, resonance, env: { amount, attack, decay }, lfo: { rate, depth } }`。
- `automation: [{ target: "filter.cutoff", from: 300, to: 6000, bars: [0, 8], curve: "exp" }]`。
- `sidechain: { source: "kick", depth, attack, release }`，作用到 bass/pad 的 bus。
- 实现状态变量滤波器（SVF），按 block 处理，避免逐样本对象分配。

**验收：** cutoff 扫描时谱质心单调变化；sidechain 在 kick 后产生可测的 gain dip；高 resonance 不产生 NaN/爆音。

**现状：部分实现（M3）。** per-track `filter`（TPT 状态变量低通，`resonance`/`q` 0.5-20，`lfoHz` + `lfoDepth` 八度调制）、section `filter` 的 `{from,to}` 指数扫频、kick 触发的 `duck` 已实现；任意 sidechain 源（目前只有 kick）和通用 `automation` 尚未实现，见 7.3。

#### P1-3 分层、立体声、空间

**当时限制：** 合成器 mono，只有全局 reverb 制造宽度；没有 pan、send、delay、unison。

**参考证据：** 12 个 layer 文件；width 中位数 0.26–1.5；47 个 wet 版本；bass 的 sub 与 mid 分层。

**设计建议：**

- 每轨 `pan`、`width`、`send`（reverb/delay）。
- `layers` 或 track group：sub + mid bass、kick + sub、pad + arp。
- `unison: { voices, detune, spread }` 做宽。
- `delay: { time: "3/16", feedback, pingpong }`。
- 总线：drum bus、bass bus、music bus，各自压缩/饱和/混响。

**验收：** pan 改变 L/R 能量比；unison 的 side 能量 > 0；send 改变尾音长度而不影响干声。

**现状：部分实现（M3）。** `pan`（等功率，居中增益 1）、`send`（mono send 总线 + 独立混响，loop 模式取 3 遍稳态）、`delay`（按 step 计时，loop 模式 3 遍预热）已实现；unison、track group 与 bus 级处理属于 M4。宽度验收改由 pan + send 的左右声道差异间接覆盖，没有单独计算 correlation。

#### P1-4 转场 FX

**当时限制：** 只有 note-level effect，没有 riser/sweep/impact/sub drop。

**参考证据：** 10 rise、22 sweep、11 impact、11 boom、20 zap；demosong 段落边界处能量/质心突变。

**设计建议：**

- 增加 `fx` 事件：`riser`、`sweep_up`、`sweep_down`、`impact`、`sub_drop`、`zap`、`reverse`、`noise`。
- 用 `bars`/`steps` 指定时长，内部自动做 pitch/filter/volume 包络。
- 绑定到 section 边界：`{"type":"riser","bars":4,"to":"drop"}`。

**验收：** riser 的谱质心随时间上升；impact 在起点有峰值；sweep 不削波。

**现状：部分实现（M3）。** riser/sweep 目前用 section `filter` 的 `{from,to}` 指数扫频表达；独立的 `riser`、`impact`、`sub_drop` FX 事件与采样尚未实现，见 7.3。

### P2：成品度与迭代效率

#### P2-1 Mix / master

**当时限制：** 只有共享 peak ceiling；没有 compression、saturation、EQ、loudness。

**参考证据：** demosong RMS 约 −8.7 到 −12.7 dBFS；drum loop crest 19.9 dB；分析时插件输出 RMS −17 dBFS。

**设计建议：**

- bus compressor / glue、saturation、tilt EQ、limiter。
- 目标响度（如 −14 LUFS integrated）和 true peak ceiling（当前 limiter 是 sample-peak，不做 4× 过采样）。
- sidechain 与 mix bus 结合。
- 保留 `limitPeak` 作为最后的安全网，不要把它当混音。

**验收：** 无样本超过 ceiling；LUFS 在目标 ±1；bypass 时与旧输出一致。

**现状：已实现（M4），见 7.4。** 五个 master 步骤 `tilt`、`saturate`、`compress`、`loudness`、`limiter` 都是 `post` 链里的普通步骤，按数组顺序执行；`loudness` 用 BS.1770 K 加权积分响度算增益，`limiter` 有瞬时启动/指数恢复和硬 ceiling。`limitPeak` 仍是最后的共享增益安全网。兼容性由固定输入、固定选项的 golden WAV hash 测试保护；仓库没有 M3 时代的历史 fixture，所以不再声称与旧版本逐字节一致。

#### P2-2 让模型「听见」结果

**当时限制：** 工具只返回路径、时长、速度、preset/post 摘要；模型无法判断自己写的是不是太暗、太窄、太稀。

**设计建议：**

- 渲染后返回一段紧凑报告：peak/RMS、谱质心、频带能量、立体声宽度、onset 密度、每段能量、警告（如「2 kHz 以上几乎没有内容」「bass 与 kick 低频重叠」「段落能量没有变化」）。
- 可选 `analyze` 工具，对已有的渲染输出做同样分析。
- 这让模型能迭代，而不是一次盲写。

**验收：** 报告字段与已知输入单调对应；警告在明显缺失时触发。

**现状：已实现（M4），见 7.4。** `renderLoop` 在写出 WAV 前对成品音频做一次测量，报告随 `p8_music` 结果返回；`p8_analyze` 对已有 WAV 做同样的测量。字段和警告见 README 的「渲染报告」一节。

## 5. 目标 score 形态

保持向后兼容：旧 score 不写新字段时，行为不变。新字段全部可选。

> 本节是提案，不是当前的 wire format：示例里的 `key`、`voices`、`glide`、`energy`、`fill`、`riser`、`tail`，以及 `post` 的 `{ "type": "limiter" }`、`timeStretch`、`varispeed` 目前都还不被 `parse.ts` 接受。已实现的字段以 [`../README.md`](../README.md) 的字段表与 `p8_help` 为准。

### 5.1 Loop 模式的扩展

```json
{
  "bpm": 165,
  "stepsPerBeat": 4,
  "bars": 8,
  "swing": 0.12,
  "key": "Fm",
  "seed": 1234,
  "post": [],
  "tracks": [
    {
      "role": "drums",
      "pattern": "K:1 -:1 K:1 -:1 S:1 -:1 K:1 K:1"
    },
    {
      "role": "bass",
      "instrument": { "type": "chip", "waveform": "tilted_saw" },
      "pattern": "F1:1 F1:1 C2:1 F1:1 D#2:1 F1:1 C2:1 A#1:1",
      "glide": 0.04,
      "filter": { "cutoff": 900, "resonance": 0.5 },
      "pan": 0,
      "send": 0.1
    },
    {
      "role": "lead",
      "voices": 3,
      "pattern": "[F4,Ab4,C5]:8 [D#4,G4,A#4]:8",
      "pan": 0.2,
      "send": 0.3
    }
  ]
}
```

要点：

- `role` 提供默认音色/包络/混音，模型只写偏离默认的部分。
- `instrument.type` 只区分 `chip` 与 `drums`；`chip` 是音色类别，和 `mode`、`style` 不是一回事。
- `post: []` 表示干声；`preset: "dreamy"` 才等价于现在的 slow+reverb。
- `glide`、`filter`、`pan`、`send` 都是 track 级默认，可被 note 级覆盖。

### 5.2 Song 模式

```json
{
  "mode": "song",
  "bpm": 165,
  "key": "Fm",
  "patterns": {
    "drums.A": "K:1 -:1 K:1 -:1 S:1 -:1 K:1 K:1",
    "drums.B": "K:1 -:1 K:1 K:1 S:1 -:1 S:1 S:1",
    "bass.A": "F1:1 F1:1 C2:1 F1:1",
    "bass.B": "F1:1 F1:1 C2:1 F1:1 D#2:1 F1:1 C2:1 A#1:1",
    "lead.A": "[F4,Ab4,C5]:8 [D#4,G4,A#4]:8"
  },
  "arrangement": [
    { "name": "intro", "bars": 8, "mute": ["drums", "bass"], "filter": 1200 },
    { "name": "build", "bars": 8, "patterns": { "drums": "drums.A", "bass": "bass.A" }, "riser": 4 },
    { "name": "drop", "bars": 16, "patterns": { "drums": "drums.B", "bass": "bass.B", "lead": "lead.A" } },
    { "name": "break", "bars": 8, "mute": ["drums", "bass"], "filter": 600 },
    { "name": "drop2", "bars": 16, "patterns": { "drums": "drums.B", "bass": "bass.B", "lead": "lead.A" } },
    { "name": "outro", "bars": 8, "mute": ["drums"], "tail": 2 }
  ]
}
```

要点：

- `arrangement` 只引用 pattern 名，避免 JSON 膨胀。
- 每个 section 可以覆盖 track 的 pattern、mute、gain、filter、fill、riser。
- `tail` 控制结尾混响尾巴；`mode: "loop"` 时仍走现有的无缝循环。

### 5.3 Post 链

```json
{
  "post": [
    { "type": "tape", "speed": 0.8, "wow": 0.1, "flutter": 0.05 },
    { "type": "reverb", "wet": 0.45, "room": 0.9, "damp": 0.5 },
    { "type": "limiter", "ceilingDb": -1 }
  ]
}
```

要点：

- `slow`/`tape` 与 `reverb` 分开；可以只 slow、只 reverb、都不做。
- `speed` 与 `pitch` 分开：`tape` 是耦合的（像现在），`timeStretch` 只改速度，`varispeed` 只改音高。
- `preset` 保留为 `post` 的快捷方式；新增 `style` 作为「作曲/音色/混音默认值」的快捷方式。两者不要混在一起。
- 三个概念分开：`mode`（`pico` / `studio`）是能力上限，`style`（`chip` / `hitech` / `ambient`）只填默认值，`preset` 只管 post 链。`style` 不改变 `mode`；显式字段 > `style` > 内置默认值。
- style 用 `chip` 而不是 `pico`，因为 `pico` 已经是 `mode` 的取值；`style: "chip"` 表达的是「按 PICO-8 约束做干声」的默认值组合，不是新的能力上限。

## 6. 架构调整

### 6.1 拆开「合成」和「后处理」

```
score -> renderSong(score) -> AudioBuffer (stereo, sections)
      -> applyPost(audio, postChain) -> AudioBuffer
      -> selectLoop / repeat / encodeWav
```

分析时的 `renderLoop()` 把 synth、resample、lowpass、reverb、loop 提取、repeat 全串在一起。拆开后：

- `features/render/voices.ts`：每轨/每 voice 合成、发音法、复音。
- `features/render/drums.ts`：鼓音色。
- `features/render/filters.ts`：SVF、包络、LFO。
- `features/render/automation.ts`：section/参数自动化。
- `features/render/mix.ts`：pan/send/bus/sidechain/compressor。
- `features/render/post.ts`：slow/tape/reverb/delay/limiter。
- `features/render/render.ts`：只做编排和调用。

模块分工与兼容策略见 [`design-boundaries.md`](./design-boundaries.md)。

### 6.2 score 模块的扩展

- `parseScore()` 继续返回旧 `Score`，新增字段可选。
- 新类型：`Section`、`PatternBank`、`Automation`、`FilterSettings`、`PostChain`。
- 旧测试全部保留；新增字段的默认值必须让旧 score 渲染结果完全一致（或只在显式使用新字段时变化）。

## 7. 里程碑与实现状态

如果资源只够做一个里程碑，先做 M1；它把产品从「loop 生成器」变成「能编段的引擎」。

### 7.1 M1：能写出「有鼓、有段落」的 16 小节

- 鼓 voice + drum token。
- `sections` / `arrangement` + mute/gain/filter。
- `post: []` 干声路径。
- 验收：一个 16 小节 demo，包含 intro/drop/break，鼓、bass、lead 同时存在；旧测试全过。

**M1 状态：已实现。**

- 鼓：`role: "drums"`，token `K/S/H/O/C/T/R/X`（大写 `R` 是 rim，小写 `r` 仍是休止）；8 个合成鼓 voice，one-shot 独立渲染、尾音可重叠，支持 `@力度`；stem 测试用 zero-crossing 区分 kick/snare/hat 的亮度。
- 段落：`mode: "song"` + `arrangement`，section 支持 `bars`、`patterns`、`mute`、`gain`/`gains`、`filter`；顶层和 track 内都支持命名 pattern；渲染前展开成绝对 step timeline。
- 干声：`post: []`；`tape`/`slow`、`lowpass`、`reverb` 可自由组合，`preset` 只作为 post 快捷方式。
- 示例：`examples/m1-16bar.json`，4 段 × 4 小节，intro/break 静音鼓和 bass 并加低通，build/drop 全编制。
- 验证：当前测试全过，覆盖 drum token、arrangement 解析、mute/gain/filter、song 时长、干声和旧 loop 行为。
- 手动 stem 检查（4096 点 DFT，约 93 ms 窗）：kick 的 body 扫频 45–150 Hz，snare 谱质心约 1.5 kHz，hat 约 13 kHz；16 小节 demo 的四段 RMS 为 intro 0.057 / build 0.155 / drop 0.227 / break 0.047，段落对比明确。
- M1 暂未做：section 级 `fill`/`riser`、per-track filter、song 结尾的混响 tail；这些留到 M3/M4。

### 7.2 M2：能写出「有和声、有发音法」的 loop

- `voices` / chord token；`key` / `scale`（可选）。
- slot 与 gate 分离；per-note ADSR；参数化 slide/vibrato/arp。
- swing + humanize + seed。
- 验收：三和弦、staccato bass、legato lead、swing 16 分都能被测量。

**M2 状态：已实现并在 M2.5 补齐高杠杆项。**

- 已实现：`[C4,E4,G4]` 显式和弦（最多 4 声部）、命名和弦（`Cmaj7`、`Fm/E`、`{C7}`）、根音八度、slot/gate 分离（`4g2` / `4g6`）、score 级 `swing`。渲染按事件调度，每个音独立 phase/包络，和弦和 legato 自然重叠。
- M2.5 追加：顶层 `envelopes` + `~pluck` 命名 per-note ADSR；参数化 `~vib(depth[,rate])` / `~slide(steps)`；`seed`。命名和弦在解析期展开成 midi，渲染与显式写法逐样本一致；包络和效果参数只改 `renderMelodicNote` 的取值，没有新增渲染路径。
- 验收：三和弦基频峰、staccato/legato 尾部 RMS、swing onset 偏移、命名/显式和弦逐样本一致、命名包络尾部 RMS、slide 到达时间、seed 的确定性与差异性都有测试。
- 示例：`examples/m2-chords-gate-swing.json`、`examples/m2.5-harmony-envelope.json`。
- 仍不做：`key`/`scale` 度数记谱、voice leading、参数化 arp、humanize、tuplet。`key` 的收益被命名和弦覆盖大半，且与显式音名存在语义冲突；voice leading 需要跨 section 的和声状态，效果主观难验收；humanize 有循环接缝陷阱；tuplet 会击穿整数 step 模型。
- 验证：当前测试全过。

### 7.3 M3：能写出「有运动、有空间」的段落

- per-track filter + envelope/LFO + automation。
- sidechain、pan、send、unison、delay。
- riser/sweep/impact/sub_drop FX。
- 验收：acid bass 的谱质心随时间移动；kick 触发 bass duck；宽度 > 0.6；riser 质心上升。

**M3 状态：混音/运动核心已实现。**

- 重构：`renderScore()` 先给每条 track 一个独立 buffer，再做滤波、延迟、duck、pan、send，最后求和。per-track 处理不再是「接在总线上」的近似。
- 已实现：per-track `filter`（TPT 状态变量低通，`resonance`/`q` 0.5-20，`lfoHz` + `lfoDepth` 八度调制）；section `filter` 支持 `{from,to}` 指数扫频，riser/sweep 直接用这个；`pan`（等功率，居中增益 1）；`send`（mono send 总线 + 独立混响，loop 模式取 3 遍稳态）；`duck`（所有 kick 触发，5 ms 启动 / 110 ms 释放）；`delay`（按 step 计时，loop 模式 3 遍预热）。
- 验收：filter 静态开合的高频带能量比、LFO 的窗口能量起伏、段落扫频的首尾高频带比、pan 的左右 RMS、duck 的 kick 窗口 RMS、send 的尾音、delay 的偏移窗口 RMS 都有测试；示例 `examples/m3-space-motion.json`。
- 仍不做：unison、任意 sidechain 源（目前只有 kick）、独立的 impact/sub_drop FX 与采样；这些属于后续里程碑。bus compressor/EQ/limiter/LUFS 在 M4 补齐。宽度验收改由 pan + send 的左右声道差异间接覆盖，没有单独计算 correlation。

### 7.4 M4：能「混音」和「自检」

报告先行：master 链的响度、削波和宽度要靠报告来验收，反过来不成立。

1. 渲染报告 / analyze 工具（P2-2）。
2. bus compressor、saturation、EQ、limiter、LUFS（P2-1）。
3. style presets：`chip`（PICO-8 约束下的干声默认值）、`hitech`（鼓+sidechain+宽）、`ambient`（slow+reverb）。

`style` 只填默认值，不改变 `mode`；风格名用 `chip` 而不是 `pico`，避免与 `mode: "pico"` 同名。

**验收：** 响度达标、无削波、报告能指出「太暗/太窄/太稀」。

**M4 状态：已实现。**

- 报告：`renderLoop` 对 loop 本体或整首 song 测量 peak/RMS/积分 LUFS/幅度谱质心与五个频带/宽度/onset 密度/分段 RMS，并生成 `dark`、`narrow`、`sparse`、`low-heavy`、`quiet`、`loud`、`flat-sections`、`trimmed` 警告。报告是 `RenderOutput.report`，`p8_music` 把它附在工具结果里；`p8_analyze` 对已有 WAV 复用同一套测量（`decodeWav` 只接受 16-bit PCM）。
- master 链：`post` 新增 `tilt`、`saturate`、`compress`、`loudness`、`limiter`；`loudness` 与报告共用同一个 BS.1770 实现，所以「命中 -14 LUFS」可以被报告直接验证。`limitPeak` 保留为最后的安全网，limiter 才是 mix 的一部分。
- style：`chip`（干声）、`hitech`（饱和 + glue + -14 LUFS + limiter）、`ambient`（slow + lowpass + reverb + limiter）；`style` 只填 post 默认值，不改 `mode`，与显式 `preset` 互斥。
- 验收：`target -14 LUFS + limiter -1` 的报告落在 -14 ±1、峰值 ≤ -0.9 dBFS；热目标 `-6 LUFS + limiter -3` 下解码后的每个样本都不超过 -3 dBFS；压缩把两段 gain 1 / 0.15 的能量差从 16.5 dB 压到 2.2 dB；低通 300 Hz 的单音触发 `dark`/`narrow`/`sparse`；鼓循环不误报 `dark`/`narrow`；两段等能量的 song 触发 `flat-sections`。
- 兼容：固定 score 与 post 选项的 dry/classic/hitech 输出由 golden hash 测试保护；没有 M3 时代的历史 fixture，不声称与旧版本逐字节一致。

## 8. 一句话总结

最高杠杆的五组能力是：**鼓、段落、gate/发音法、和弦与动机发展、滤波自动化**；同时把 **slow+reverb 从产品身份降级为 post preset**。如果只能先做一个里程碑，选 M1（鼓 + 段落 + 干声），它改变的是产品类别；继续加波形或效果参数只是边际优化。做完这些，插件才从「能生成一个慢速氛围 loop」变成「能编出一段有节奏、有和声、有起伏的 PICO-8 风格音乐」。

## 延伸阅读

- [`evaluation.md`](./evaluation.md)：曲目评分维度——六个维度、测试策略、盲听清单。
- [`design-boundaries.md`](./design-boundaries.md)：设计边界与风险——产品、模块、兼容、资源四类边界。
- [`features/score.md`](./features/score.md)、[`features/render.md`](./features/render.md)：两个 feature 的 owns / does-not-own 契约。
- [`../README.md`](../README.md)：已实现的能力与调用方式。
