# 曲式与输出形态：cue 与 stems

**状态：提案，未实现。** 当前可用的曲式只有 `loop` 与 `song`，`p8_music` 只输出一个 WAV。本文定义两个候选扩展的语义、边界和落点，供实现前拍板；代码落地前，`mode: "cue"` 或任何 stems 参数都不应出现在 `src/features/score/help.ts`、`pico8-songwriter` 技能或 README 的可用字段表里。

## 1. 三条轴，不要都叫 mode

曲式、默认值、输出形态是三件事。把它们混成一个 `mode` 会让同一个词在文档、schema 和报告里指向不同东西。

| 轴 | 字段 / 入口 | 取值 | 现状 |
| --- | --- | --- | --- |
| 曲式 | `mode` | `loop` / `song`（候选 `cue`） | `loop` / `song` 已实现 |
| 默认值 | `style`、`preset`、`quality` | `chip` / `hitech` / `ambient` / `studio` / `lofi` / `soft`；`pico` / `clean` | 已实现 |
| 输出形态 | `out` | WAV（候选 stems 目录） | WAV 已实现 |

命名纪律：

- `mode` 只回答时间线问题：单圈无缝重复、有编排的一遍、还是定长一遍。它不表达音色、能力上限或导出格式。
- `pico` 是 `quality` 的取值，`studio` 是 `style` 的取值；两者都不再作为 `mode` 的取值。
- `report.stems` 是每轨的分析读数（RMS、质心、频带、pan），不是音频文件。本文说的 stems 是分轨导出，两者必须在文档里写全称呼，必要时用「分轨」区分。
- 新增曲式或导出目标必须 opt-in；未请求时，现有 `loop` / `song` 的 WAV 逐字节不变。

## 2. 提案 A：`cue` 曲式

### 2.1 语义

`cue` 是「按谱面渲染一遍、不循环、允许收尾」的定长曲式。它和 `loop` 共用 pattern 排程，和 `song` 共用「只渲染一遍 + 可带 tail」，但不需要 `arrangement`，也不提供段落变速。

适用场景：jingle、stinger、UI 音效、过场提示音、采样素材里需要精确长度的 one-shot。`loop` 也能写得很短，但它会按 `minutes` 重复并裁成无缝环；`cue` 明确拒绝这种重复。

```json
{"mode":"cue","bpm":120,"bars":2,"tail":0.6,"tracks":[
 {"name":"lead","role":"lead","waveform":"pulse","pattern":"C5:2 E5:2 G5:4 C6:8"},
 {"name":"bass","role":"bass","waveform":"tilted_saw","pattern":"C2:4 G1:4 C2:8"}]}
```

### 2.2 规则

| 项目 | `loop` | `song` | `cue` |
| --- | --- | --- | --- |
| `arrangement` | 禁止 | 必需 | 禁止 |
| pattern 排程 | 按 `bars` 重复铺满一圈 | 按 section 展开 | 同 `loop` |
| 输出长度 | `minutes` 指定的重复段数 | 一遍 + `tail` | 一遍 + `tail` |
| `tail` | 禁止（破坏无缝） | 允许 | 允许 |
| `minutes` | 使用 | 忽略 | 忽略 |
| 段落 / 段落变速 | 无 | 有 | 无 |

- `bars` 必填，1-64。
- 出现 `arrangement` 即报错，不能靠 `cue` 绕过 section 校验。
- `tail` 允许 0-30 秒；它不计入音乐长度，只加到 WAV 末尾。
- `minutes` 对 `cue` 无意义，按 `song` 的既有约定忽略，不静默重复。
- `cue` 不提供「逐段空间/力度」：需要段落就写 `song`。

### 2.3 实现落点

- `src/features/score/parse.ts`：`parseMode()` 接受 `cue`；`bars` 走 loop 的整数校验；`tail` 的拒绝条件从「非 song」改成「loop」；未知字段、pattern 对齐警告复用 loop 分支。
- `timelineOf` 不需要改：`cue` 和 `loop` 一样把 pattern 重复到 `totalSteps`，只是渲染器不再重复整圈。
- `src/features/render/synth.ts`：`wrap = mode === 'loop'`；`tailSamples` 对 `cue` 与 `song` 都生效。
- `src/features/render/render.ts`：这是主要风险点。现在有十几处 `score.mode === 'song'` 分支，分别控制稳态预卷、重复次数、tail 淡出、分段读数、母带测量窗口和最终长度。直接加 `|| cue` 很容易漏掉一处。建议先抽三个谓词——`wraps(score)`、`hasTail(score)`、`onePass(score)`——做纯重构并用现有 golden 测试确认输出不变，再加 `cue`。
- `cue` 不能复用 loop 的三遍稳态预卷和裁切：没有接缝，就没有「上一圈的尾音」要折进来。send 混响的尾音落在 `tail` 里，和 `song` 的收尾方式一致。
- `src/app/render-service.ts`：报告里的 `loop ... × repeats` 一行对 `cue` 应显示 `one pass`，避免让人以为还能重复。

### 2.4 验收

- `cue` 的 WAV 长度精确等于 `bars × stepsPerBar × stepSeconds + tail`，不含第二次重复。
- `tail` 在 `cue` 中生效，在 `loop` 中仍然报错。
- 同一份 pattern 在 dry、无 send 的 `loop` 与 `cue` 下，单圈内容逐样本一致；差别只在重复与接缝处理。
- 不写 `mode` 的旧 score、以及现有 `loop` / `song` 的输出逐字节不变。

### 2.5 未决问题

- 名字：`cue`、`oneShot`、`stinger`。`cue` 最短，但和「提示音」的语义绑定较紧；如果主要用途是音效，`oneShot` 更直白。
- 是否值得做：单段 `song` 已经能表达「一遍 + tail」，`cue` 的增量只有「不写 `arrangement`」和「明确不重复」。如果 §2.3 的谓词重构做不完，建议先不做，避免为了一个语法糖碰整条渲染分支。

## 3. 提案 B：stems 分轨导出

### 3.1 术语

本文的 stems 是**分轨音频文件**。现有 `report.stems` 是渲染时对每轨做的测量摘要，只留在报告和 `.analysis.json` 里；它不保留音频，也不能导出。实现时不要复用同一个名字不加限定，建议工具参数叫 `stems`，报告字段保持 `stems` 但在文档里写作 `report.stems`。

### 3.2 颗粒度

| 取值 | 信号链位置 | 声道 | 用途 |
| --- | --- | --- | --- |
| `tracks` | 每轨 filter / EQ / delay / duck / section filter 之后，pan / send / group 之前 | mono | 重混、替换音色、分析单轨 |
| `groups` | 组内成员求和并做完组级 filter / EQ / delay / duck 之后，组 fader / pan / send 之前 | stereo | 分组重混、鼓组/键盘组单独处理 |
| `sends` | 每个 reverb send 总线（默认返回 + 每个具名组返回） | stereo | 单独拿混响湿声做效果 |
| `mix` | 与当前 WAV 相同：section filter/width、send 返回、post 链、limiter 之后 | stereo | 对照母带结果 |

关键取舍：

- **母带不能逐轨套。** `saturate`、`compress`、`loudness`、`limiter` 都是非线性或带状态的整体处理；对每条轨分别跑一遍，再相加不等于母带输出。因此 `tracks` / `groups` / `sends` 默认都是 **pre-master**，manifest 要明确写 `master: false`；需要母带就同时给 `mix.wav`。
- **`tracks` 是 pre-pan / pre-send 的 mono。** 这正是 `analyseStem` 的测量点，因此分轨和报告能对得上。consumer 要复现当前混音，还得按 manifest 里的 pan、send、group 重新声像和加混响；这不是「一加就等于成品」的 stem。
- **`groups` 是 pre-fader / pre-send。** 组 bus 在渲染器里先求和再做插入处理，fader/pan 是写进主总线时才应用的；导出时要决定是保留这个位置，还是在写盘前补上 fader/pan。推荐保留 pre-fader，并把 `gain` / `pan` / `send` 写进 manifest，语义最清楚。
- **send 湿声默认不混进 track stem。** 否则每条轨都要单独跑一遍 reverb，32 轨就是 32 次混响，成本和内存都不划算。需要湿声就显式导出 `sends`，或用 `groups`。

### 3.3 输出契约

建议一次导出写成一个目录，避免和 `out` 的单个 WAV 抢路径：

```
<out>.stems/
  manifest.json
  mix.wav                    # 可选，与 p8_music 的 out 相同
  01-track-drums.wav         # tracks 颗粒度：mono
  02-track-bass.wav
  group-drums.wav            # groups 颗粒度：stereo
  send-default.wav           # sends 颗粒度：stereo
```

`manifest.json` 至少包含：

- `rate`（44100）、`sampleFormat`（`pcm_s16le`）、`channels`、`frames`；
- `mode`、`bpm`、`stepsPerBeat`、`beatsPerBar`、`bars`，以及 song 的 section 时间线（`startStep` / `startSeconds` / `bpm`）；
- `loopStartFrame` / `loopEndFrame`（仅 loop；cue 和 song 不写循环点）；
- 每个文件的 `name`、`role`、`group`、`pan`、`send`、`gain`、`muted`、`preMaster`；
- section 级 track/group 状态（`pan`、`send`、`filter`、`gain`、`space`、`width`），否则带段落自动化的分轨无法重建；
- `post` 链、`style`、`quality`、`tailSeconds`；
- 源 score 的稳定标识（至少是内容 hash），避免分轨与 WAV 对不上。

对齐规则：

- 所有分轨帧数相同、起点相同；静音轨也写等长静音文件，或在 manifest 里标 `muted: true`，不能靠省略文件来改变索引。
- loop 模式只导出一圈，不导出 `minutes` 指定的重复；循环点写进 manifest，consumer 自己重复。这样 15 分钟的 loop 不会变成 15 分钟 × 32 轨。
- song 模式导出整首 + `tail`；`loopStartFrame` / `loopEndFrame` 不适用于 song，manifest 可省略。

### 3.4 实现落点与成本

- **内存**：`renderScore` 现在逐轨渲染、逐轨求和，只保留一条轨的 buffer；组 bus 和 send bus 会保留。分轨导出应在每轨 DSP 完成后立刻写盘，而不是保留 32 条整段 buffer（15 分钟 × 32 轨 × 44.1 kHz × 4 字节 ≈ 5 GB，mono Float32）。
- **CPU / I/O**：`tracks` 不需要额外 DSP，只增加写盘；`groups` 可以在现有 group bus 后直接写；`sends` 需要等 reverb 返回生成后写；`mix` 已经存在。track/group stems 是 pre-send 的，loop 只写一圈就能和成品中的对应部分对上；如果要做带 send/post 的湿分轨，每条轨/总线都要重复同样的稳态预卷，成本按轨数增长。默认把 stems 定义为 dry/pre-send，避免这个成本。
- **duck**：`collectKickOffsets` 是全局的，逐轨写盘时复用同一份 kick 偏移即可，不需要重算。
- **abort**：写每条轨前检查 signal；大目录导出要保证中途 abort 不留下半套文件（先写临时目录，完成后 rename）。
- **工具面**：
  - 方案 A（推荐）：`p8_music` 新增 `stems: "tracks" | "groups" | "sends" | "mix"`，与 `out` 并列。这样 style / quality / post / tuning / samples 天然和主 WAV 用同一份参数，不会出现「分轨和成品不是同一次渲染」。
  - 方案 C：独立 `p8_stems` 工具。命名最干净，但会多一套参数 schema 和宿主注册；可以等方案 A 稳定后再拆。
- **app 层**：目录创建、路径越界检查、manifest 写入、临时目录 rename 都归 `app`；`render` 只负责给出每轨/每组/每条 send 的音频和元数据，不碰文件路径。

### 3.5 验收

- 不传 `stems` 时，现有 WAV 逐字节不变；传 `stems` 时，`mix.wav` 与不导分轨时的 `out` 一致。
- `tracks` 分轨帧数一致；按 manifest 的 pan / send / group / section 状态重新声像和发送后，与同一渲染的 pre-post 混音在浮点误差内一致；母带侧步骤（section width、limiter 等）只在 `mix.wav` 上验证。
- loop 模式只写一圈，`loopStartFrame` / `loopEndFrame` 有效；不因 `minutes` 膨胀。cue 不写循环点，长度就是一遍 + tail。
- song 模式的分轨覆盖整首 + tail，section 边界对齐。
- 32 轨、15 分钟的上限下，导出不会把整首 × 32 留在内存；中途 abort 不留下不完整目录。
- `muted` 轨仍然出现在 manifest 和文件列表里（静音文件），保证索引稳定。

### 3.6 未决问题

- track stem 要 mono 还是 stereo？mono 与 `report.stems` 的测量点一致，但 consumer 还得自己 pan；stereo 更接近成品但会掩盖 send/group 的归属。
- loop 的 stems 要不要顺便导出重复后的版本？建议不，manifest 的循环点足够；需要固定长度时让 consumer 自己 repeat。
- 是否提供 zip 打包？目录更透明，但 32 轨 × 15 分钟的体积很大；可以先不打包，由宿主或用户处理。
- `sends` 是否默认包含？会增加一次 reverb 写盘和 listener 的心智负担；建议默认只导出 `tracks` 或 `groups`，`sends` 显式请求。

## 4. 明确不做的形态

| 形态 | 为什么不做 |
| --- | --- |
| album / suite（多首拼成一张） | 这是多次调用与文件编排，属于宿主或用户脚本，不需要新曲式。 |
| adaptive / 纵向分层（游戏交互音乐） | 真正的增量是「分层 stem + 过渡点/同步元数据 + 运行时切换协议」，比 stems 大一个数量级；先把 stems 做稳，再单独设计。 |
| free-time / 秒级非网格 | 现在所有事件锁在 step 网格上；放开会同时改 parser、timeline、swing、section 对齐和 loop 接缝。低 bpm + 长音 + sample 已能覆盖大部分氛围需求。 |
| live / streaming | 渲染在工具调用内同步完成；流式输出会改变整个 app 的写文件契约。 |
| generative / 实时变化 | 分数本身是持久化对象，`seed` 已经提供确定性变化；真正的生成式会和「模型写死谱面」的验收方式冲突。 |

## 5. 实施顺序建议

1. 纯重构：把 `score.mode === 'song'` 的分支收成 `wraps` / `hasTail` / `onePass` 三个谓词，golden 测试确认输出不变。
2. 加 `cue`：parse、tail 规则、渲染长度、报告文案；不碰 stems。
3. 加 `stems: "tracks"`：pre-send mono、manifest、目录与 abort 清理；先只支持 loop/song。
4. 视需求再加 `groups` / `sends` / `mix`，以及 `cue` 的分轨；每加一种颗粒度都要补「不请求时逐字节不变」的测试。

文档纪律：先改 `parse.ts`，再改 `help.ts`；只有「怎么用这个参数写出好听的曲子」发生变化时才动 `pico8-songwriter` 技能；README 的字段表和「已知限制」最后同步。`mode` 的枚举保持封闭，不要把 `stems`、`pico`、`studio` 塞进去。
