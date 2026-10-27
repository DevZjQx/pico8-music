# 落点微调计划：轨道级与逐 token 的 onset 偏移

**状态：方案 A 与方案 B 已实施。** 本文定义两个方案（A 轨道级、B 逐 token）的语义、边界、执行顺序与验收；`offsetMs`、`~drag`/`~push`、逐轨 `swing` 与字段级 `humanize` 覆盖已进入 `parse.ts`、`synth.ts`、`help.ts`、README 和技能。本文件保留原始语义说明，范围以 `p8_help` 为准。

它延续 [`space-energy-plan.md`](./space-energy-plan.md) 的原则：默认中性、旧 score 逐样本不变、只提供可组合的原语、不自动混音；也延续 [`design-boundaries.md`](./design-boundaries.md) 的定位：不做 DAW 式自动化，不把分数变成程序。

## 1. 要补的缺口

分析时时间轴只有整数 `step`（当时 `bpm` 30–300、`stepsPerBeat` 1–8、`beatsPerBar` 1–16；现在上限已放宽到 24）。常见配置下的实际粒度：

| 配置 | 一步长度 |
| --- | --- |
| 90 bpm / 4 | 166.7 ms |
| 120 bpm / 4 | 125 ms |
| 165 bpm / 4 | 90.9 ms |
| 300 bpm / 8 | 25 ms（最细） |
| 30 bpm / 1 | 2 s（最粗） |

音符起点、slot、gate 都只能是整数步。现有的“时间感”工具都补不上“这一个音晚 15 ms”：

- `swing`：全局，只作用于奇数步，-0.5..0.5 步（`synth.ts` 的 `swingSeconds`），不能按轨道或音符。
- `humanize.timingMs`：全局深度 0–150 ms，确定性伪随机，只能“整体松一点”，不能指定某个事件的偏移量。
- `~flam(ms)`：只给鼓加第二下（5–40 ms），不是 onset 位移。
- 包络的 attack/release 是秒级，但只改音头/音尾形状，不改落点。
- 采样的 `start`/`end` 是秒级，但只改素材内部，不改事件在时间线上的位置。

结论：模型能写“第几步”，不能写“这个军鼓比网格晚 15 ms，底鼓早 10 ms”。

## 2. 为什么不做分数网格

| 方案 | 改动面 | 成本 | 风险 | 判断 |
| --- | --- | --- | --- | --- |
| A. 轨道级 `offsetMs` | 解析 + 两处调度 | ~0.5 天 | 极低 | 值得，先做 |
| B. 逐 token `~drag(ms)`（±半步） | 解析 + token 语法 + 两处调度 + 文档 | 1–2 天 | 低 | 最值得 |
| C. 分数 `step`（三连音/`C4:3.5`） | parser、swing、段落对齐、loop 接缝、structure、全部时序测试 | 1–2 周 | 高 | 暂不做 |
| D. 绝对秒时间戳 `at: 2.35` | 破坏 pattern/loop 语义，且被 B 覆盖 | — | — | 不做 |

关键等价：任意时刻 `t` 一定落在某个整数步的 ±半步之内。

```
t = 最近的 step 起点 + 残余偏移（|残余| < 半步）
```

所以“整数网格 + 半步内偏移”在**落点**上等价于分数网格，但槽位推进、休止、pattern 重复、gate 语义全都不变。例：120 bpm / 4 下一步 125 ms，想落 2.35 s → 第 18 步 2.25 s + 100 ms。

它不解决“段落/滤波在任意秒切换”——那仍是小节级（`bars` 整数），两件事不要混。

## 3. 共同契约（A/B 都必须满足）

### 3.1 只移 onset，不动槽位

偏移只改变事件开始采样，不改变 `event.step`、`event.steps`、pattern 游标或 `timelineOf` 的展开结果。符号时间线仍然只有整数 step，音频时间线在调度时叠加偏移。

### 3.2 移动整个事件

`startSample` 偏移，`gateSamples` 不变，所以事件整体前后移动，而不是“起点动、终点仍锁网格”。这样 `~drag` 的军鼓仍然是一整下，不会莫名其妙变短；包络 release 也随事件一起移动。

### 3.3 钳制到 ±半步（严格小于）

有效偏移 = `clamp(轨道偏移 + token 偏移, -0.49 × 本地一步, +0.49 × 本地一步)`。

- 与 swing 同一不变量：`synth.ts` 的 `swingSeconds` 注释写明“奇数步不能跨到前一个偶数步”；偏移沿用这条。
- `< 0.5` 而非 `≤ 0.5`：相邻两步的两个事件各自反向偏移 0.49 步也不会换序（1 + 0.49 < 2 - 0.49）。
- 钳制在 render 期做，因为同一数值在不同段落 `bpm` 下的半步长度不同；warning 走 render 的 `extraWarnings`，按轨道去重，而不是每个事件刷一条。
- 解析期只检查硬范围（建议 ±200 ms），并拒绝非有限值。

### 3.4 叠加顺序

```
step 起点 → swing → 轨道 offsetMs → token offsetMs → humanize
```

全部是采样级加法；每一项都可为 0。`humanize` 的随机偏移**不再二次钳制**，保持现有行为；作者写的偏移才受半步限制。文档里要写清“offset 是作者意图，humanize 是随机漂移”。

### 3.5 接缝与边界

- **loop**：负偏移在 step 0 会从圈尾进入，现有 `renderMelodicNote` / `renderDrumHit` 的取模 wrap 已经处理；正偏移在最后一步会自然溢出到下一圈，逐采样 wrap。
- **song 起点**：现有 `Math.max(0, startSample)` 会把负偏移裁到 0；第一拍不能早于 0 是正确行为，文档写明。
- **段落边界**：`timelineOf` 仍按 `step` 截 slot/gate；偏移可以让上一段最后一个音延续到下一段开头，或让下一段第一个音提前一点。这是音频层的自然结果，**不修改**段落归属；报告仍按 `step` 归属。
- **duck/延迟**：duck 用收集到的 kick `hit.offset`，所以侧链会跟着被推/拖的底鼓走，这正是想要的；`delay` 的 `steps` 仍按网格计时，不跟随单个音符偏移。

### 3.6 符号输出降级

- `structure` 只读 `event.step`（`structure/read.ts` 按 `step` 分小节、去重 attack），忽略偏移；正向偏移不会把最后一个音推出本小节，但负向偏移可以让小节第一个音提前到上一小节。只有这种边缘情况会有“读数一小节、听感另一小节”的差异，写进已知限制。
- `p8_probe` 把偏移置 0，和它已经置 `swing: 0`、`humanize: 0` 的理由相同：探针测音色，不测落点（`probe.ts` 构造探针 score 的位置）。

### 3.7 兼容

- 字段缺省为 0；不写新字段的 score 与改动前逐样本一致。
- `test/m4.test.ts` 的 golden hash（dry / classic / hitech）必须不变。
- 新字段只在作者显式写入时生效，不做风格预设的隐式默认值。

## 4. 方案 A：轨道级 `offsetMs`（P0）

### 4.1 语义

一条轨道的所有事件整体前移/后移。等价于“这个声部整体推一点/拖一点”，是 80/20 的做法。

```json
{"name":"snare","role":"drums","offsetMs":15,
 "pattern":"S:2 -:2 S:2 -:2"}
```

- 字段：`tracks[].offsetMs`，有符号毫秒，-200..200，默认 0。
- 正值 = 晚（drag），负值 = 早（push）。
- 作用于该轨所有 melodic 事件和 drum hit，包括和弦的每个声部、`~roll` 的每一击、`~flam` 的两下。
- 不进入 `presets`：preset 是音色默认值，feel 是演奏选择，两者不混。
- 不进入 `groups` 或段落 `tracks` 状态：先证明单轨级够用，再谈分组级。

### 4.2 落点

- `types.ts`：`ScoreTrack.offsetMs?: number`。
- `parse.ts`：轨道字段表新增 `offsetMs`，用 `readNumber(value.offsetMs, path, 0, -200, 200)`。
- `synth.ts`：抽一个 `eventOffsetSamples(score, event, track, rate)`， melodic 的 `buildMelodicNotes` 和鼓的 `buildDrumHits` 都调用它；不要在两个循环里各写一份钳制逻辑。
- `help.ts`：Track 表加一行；`README.md` 的轨道字段表和已知限制同步。

### 4.3 验收

- 不写 `offsetMs` 时，现有 315 个测试与 golden hash 全绿。
- `offsetMs: 20` 在 44.1 kHz 下正好移动 882 个采样；`-20` 反向。
- loop 第 0 步 `-20 ms` 从圈尾进入，接缝无静音、无双击。
- 120 bpm / 4（半步 62.5 ms）写 `offsetMs: 200` 时被钳到 61.25 ms，并产生一条按轨道去重的 `timing-clamped` warning。
- 鼓轨的 duck 触发点随偏移移动；delay 回声时间不随单个事件移动。
- 不写 `offsetMs` 时与基线逐字节一致；`structure` 读数不变。

## 5. 方案 B：逐 token `~drag` / `~push`（P1）

### 5.1 语法

```json
{"name":"snare","role":"drums","pattern":"S:2~drag(15) -:2 S:2 -:2"}
{"name":"bass","role":"bass","pattern":"C2:4~push(10) G1:4 C2:8"}
```

- `~drag(ms)`：晚，0..200。
- `~push(ms)`：早，0..200。
- 两个名字都不接受参数符号；写 `~drag(-10)` 报错并提示改用 `~push(10)`，避免双重否定。
- 每个 token 最多一个 timing 后缀，可与一个 `~effect`、一个鼓效果、鼓参数、`@volume`、一个 `~name` 演奏法共存；timing 后缀不参与 articulation 展开。
- 和弦 token 的偏移作用于该和弦的所有声部；不做 per-voice 偏移。
- 动机变换：`retrograde` 只换顺序，偏移跟着 token 走；`augment`/`diminish` **不缩放偏移**（feel 是绝对时间，不是时值）；缩放后若超过半步，按 3.3 钳制并 warning。

### 5.2 落点

- `parse.ts`：`parseEffectSuffix` 在鼓效果/鼓参数之后、`namedSuffix` 之前识别 timing 后缀，返回新的 `{kind:'timing', offsetMs}`；`PatternToken` 与 `NoteEvent` 增加 `offsetMs?`；`formatPatternToken` 负责往返。
- 保留字：`drag`、`push` 加入保留名集合，`articulations` 不能再叫这两个名字（与 `ghost`/`flam`/`roll` 同一处理）。
- `synth.ts`：复用方案 A 的 `eventOffsetSamples`，token 偏移与轨道偏移相加后再钳制。
- `help.ts` / 技能：线格式只写语法、范围、钳制规则；“什么时候该拖、拖多少”写进技能（建议 |offset| ≤ 20 ms，只给需要强调的声部）。

### 5.3 验收

- `~drag(20)` 的 onset 比同位置无后缀事件晚 882 采样；`~push(20)` 早 882。
- `~drag` 与 `~vib`、`@6`、`~ghost` 可同时出现；与两个 timing 后缀同时出现时报错。
- `offsetMs` + `~drag` 叠加后仍钳在半步内；两者都为 0 时输出与基线逐字节一致。
- `~drag(0)` / `~push(0)` 显式中性，输出不变。
- `formatPatternToken(parsePatternToken(x)) === x` 对带 timing 后缀的 token 成立（或按现有规范化规则成立）。
- 已知限制补一条：符号结构读数忽略偏移；`p8_probe` 忽略偏移。

## 6. 不做

- **分数 step / tuplet**：会同时动 parser、swing、段落对齐、loop 接缝和 structure；收益低于成本，维持 README 现有结论。
- **绝对秒时间戳**：破坏 pattern 重复和 loop 语义，且被 B 完全覆盖。
- **允许偏移跨过半 step**：会让相邻事件换序，破坏“step 归属”和符号报告；真想换序就改 step 或重写 pattern。
- **任意自动化曲线**：仍然不做；段落 `filter` 的 from→to 已是当前上限。
- **自动 groove 模板**：先给原语，等有真实失败样本再谈预设。

## 7. 风险与取舍

- **模型滥用**：每个音都拖 30 ms 会把节奏弄散。技能文档给上限和建议；默认 0；报告不为此新增评分。
- **快 tempo 下钳制**：300 bpm / 8 的半步只有 12.5 ms，20 ms 的 drag 会被钳。warning 要给出“当前段落半步上限”，而不是静默截断。
- **段落边界听感**：偏移可能让音头越过段落线；报告按 step 归属，读数和听感可能差半步。只影响边缘个案，写进已知限制。
- **`humanize` 叠加**：作者偏移被钳、humanize 不被钳，总位移可能超过半步；这是保留旧行为的代价。
- **不变量维护**：新增的两个调度点必须共用同一个钳制函数，否则 melodic 和 drums 会走出两套边界。

## 8. 实施顺序

1. **P0（方案 A）**：先做轨道级，验证钳制、warning、loop wrap、golden hash；这一步不改 token 语法，风险最低。
2. **P1（方案 B）**：在 A 的钳制函数上接 token 后缀；补 parser 往返、保留字、和弦/鼓/动机交互测试。
3. **P2（文档）**：`help.ts`、`README.md`、技能、`docs/features/score.md` / `render.md`、`docs/design-boundaries.md` 的“已知限制”同步。
4. **验收门槛**：`bun run check` 全绿；golden hash 不变；新增测试覆盖正/负偏移、钳制、loop 接缝、song 起点、structure 不变。

## 9. 未决问题

实现前需要拍板：

1. **token 拼写**：`~drag`/`~push` 两个无符号名，还是单个 `~off(±ms)`？前者防符号错误，后者少一个保留字。本文倾向 `~drag`/`~push`，不采用 `~off`。
2. **单位**：毫秒（本文倾向）还是 step 的分数（如 `~drag(0.12)`）？毫秒更贴近“feel”，分数更 tempo-independent，但模型要换算。
3. **轨道 + token 的组合**：相加（本文倾向）还是 token 覆盖轨道？相加能让轨道定基准、token 做重音。
4. **解析期硬范围**：±200 ms 是否够？是否允许更宽但一律靠 render 钳制？
5. **warning 粒度**：按轨道去重，还是每次钳制都报？前者更安静，后者更容易定位。
6. **`~flam` 的叠加语义**：flam 的第二下从“被偏移后的第一下”再延迟 `offsetMs`（本文倾向，代码里 `pushHit` 已是相对 `startSeconds`），还是从网格点算？
7. **`p8_probe`**：置 0（本文倾向）还是保留并让分析窗口自适应？
