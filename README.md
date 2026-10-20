# pico8-music

DSH / Pi 插件：模型用 JSON 作曲，插件合成 PICO-8 风格的声音，输出 44.1 kHz 立体声 WAV。支持两种模式：

- `loop`：一条 pattern 循环，可选降速、低通、混响，输出无缝循环。
- `song`：用 `arrangement` 拼出 intro / build / drop / break，渲染完整结构。

不需要 PICO-8、ffmpeg 或 sox 等外部二进制；运行时依赖只有 `typebox`（用于 Pi 工具参数校验）。插件本身不绑定特定的 DSH profile。

## 目录

```
src/
  app/dsh-plugin.ts          # 组合层：注册 p8_music 工具、写文件
  app/pi-extension.ts        # Pi 适配层：p8_music / p8_help 工具 + /p8m 命令
  features/
    score/                   # 作曲格式、段落、鼓 token、音符/和弦解析、校验、DSL 说明
    render/                  # 合成、鼓、轨道混音、滤波、后处理、稳态循环、WAV
docs/expressiveness-review.md      # 表现力审查：从慢速混响循环到可编曲的引擎
docs/evaluation.md           # 曲目评分维度：频谱/瞬态/空间/和声/结构/响度
docs/design-boundaries.md    # 设计边界与风险：产品、模块、兼容、资源
docs/features/               # 两个 feature 的边界决策
examples/m1-16bar.json       # 16 小节 intro/build/drop/break 示例
examples/motifs.json         # motif / phrase 变换示例
examples/m2-chords-gate-swing.json # 和弦、gate、swing 示例
examples/m2.5-harmony-envelope.json # 命名和弦、命名包络、效果参数示例
examples/m3-space-motion.json # pan/send/duck/filter LFO/delay/段落扫频示例
scripts/check-boundaries.ts  # shared -> features -> app 的零依赖检查
test/
```

## 安装

```bash
npm install
npm run build                 # 产物在 dist/，prepack 也会自动构建
dsh plugin --profile web add /path/to/pico8-music
# 或 npm pack，再安装生成的 pico8-music-0.0.1.tgz
```

重启对应 profile，模型就会看到 `p8_music` 工具。插件 id 是 `pico8-music`；如果装过旧 id，先移除再重新 add。DSH 从 `package.json.dsh`（`manifestVersion: 1` 与 `bundle.patch`）读取 bundle，入口是 `dist/app/dsh-plugin.js`；Pi 入口是 `dist/app/pi-extension.js`。

## 帮助文本：`/p8m` 与 `p8_help`

PICO-8 乐谱 DSL 的完整说明不再塞进工具描述里（那会让每个会话、每次请求都带上约 3.4 KB 的乐器说明）。它只存在一处：`src/features/score/help.ts` 的 `SCORE_HELP`，两种宿主都按需读取：

| | Pi | DSH |
| --- | --- | --- |
| 人手动看 | `/p8m`，作为 custom message 写进会话，人和模型都能看到 | `/p8m` 命令，结果由 UI 渲染 |
| 模型自己看 | `p8_help` 工具 | `p8_help` 工具 |

`p8_analyze` 是配套的自检工具，两种宿主都有；它只读 WAV，不写文件。

- `p8_music` 的描述只留一句话并指向 `p8_help`；`score` 解析失败时错误信息也会提示去调用 `p8_help`。
- DSH 的命令结果按宿主约定只走 UI、不进模型历史（`@deepseek-ai/dsh-commands`："命令结果永不成为模型消息"），所以 DSH 侧模型读帮助只能靠 `p8_help` 工具；Pi 侧 `/p8m` 会额外写进上下文，因为 Pi 的 custom message 会参与下一轮请求。
- DSH 的 `commands` 是可选服务（headless 宿主没有命令面），插件用 `ctx.inject(['commands'], …)` 注册命令，不把它写进 `inject` 数组，否则没有命令面的宿主会连工具都不启动。

代价对比：改之前常驻约 4.4 KB（当时约 2.4 KB 的说明 + 1.6 KB 参数 schema + snippet/guidelines）；现在三个工具声明合计 Pi 3864 B、DSH 3339 B（JSON 字节，不含会话格式开销），3407 B 的 `SCORE_HELP` 只在真正查看帮助时才进上下文。两个宿主的工具参数来自同一份 `src/app/tool-schemas.ts`，不再各写一遍。

## 调用

```json
{
  "score": "{\"mode\":\"song\",\"bpm\":165,\"patterns\":{\"drums.B\":\"K:1 H:1 S:1 H:1\"},\"tracks\":[{\"name\":\"drums\",\"role\":\"drums\",\"pattern\":\"K:1 -:1 H:1 -:1 S:1 -:1 H:1 -:1\"}],\"arrangement\":[{\"name\":\"intro\",\"bars\":4,\"mute\":[\"drums\"]},{\"name\":\"drop\",\"bars\":4,\"patterns\":{\"drums\":\"drums.B\"}}]}",
  "post": [],
  "out": "loop.wav"
}
```

`score` 是 JSON 字符串，不是嵌套对象：这样在 DSH 和 Pi 两种宿主的参数校验下行为一致。更多示例见 `examples/m1-16bar.json`、`examples/motifs.json`、`examples/m2-chords-gate-swing.json`、`examples/m2.5-harmony-envelope.json`、`examples/m3-space-motion.json`。

### Loop 模式

| 字段 | 范围 | 默认 |
| --- | --- | --- |
| `mode` | `loop` / `song` | 没有 `arrangement` 时为 `loop` |
| `bpm` | 30-300 | 90 |
| `stepsPerBeat` | 1-8 整数 | 4 |
| `bars` | 1-64 整数（song 模式的 section 也是 1-64，可选总 `bars` 为 1-256） | 4 |
| `swing` | 0-0.5 | 0 |
| `seed` | 0-2147483647 整数，影响 noise 音色与鼓瞬态 | 0 |
| `motifs` | 可选，命名动机：`{"A":"C4:1 E4:1"}` | 空 |
| `envelopes` | 可选，命名 ADSR：`{"pluck":{"attack":0.001,...}}` | 空 |
| `tracks` | 1-4 个 | 必填 |

每个 track：

| 字段 | 说明 |
| --- | --- |
| `name` | 可选，段落覆盖时用；默认 `track0`、`track1`… |
| `role` | 可选，`drums`、`bass`、`lead`、`pad` 等；默认 `melodic` |
| `pattern` | 必填（或提供 `patterns`）。`音符:步数[g门限]` 用空格分隔，`-` 是休止；可选后缀 `@力度`、`~效果`、`~包络` |
| `patterns` | 可选，本轨的命名 pattern：`{"A":"...","B":"..."}` |
| `motifs` | 可选，本轨的命名动机；同名时覆盖顶层 `motifs` |
| `waveform` | `0-7` 或 `triangle`、`tilted_saw`、`saw`、`square`、`pulse`、`organ`、`noise`、`phaser`，默认 `pulse` |
| `volume` | 0-7 整数，默认 5。没有 `@力度` 的音符用它 |
| `envelope` | 可选 ADSR：`{attack, decay, sustain, release}`，单位秒（`sustain` 是 0-1 电平） |
| `pan` | -1（左）..1（右），默认 0；等功率，居中不改变音量 |
| `send` | 0-1，送入轨道混响 send；默认 0 |
| `duck` | 0-1，被鼓轨 kick 触发的压低深度；默认 0 |
| `filter` | 数字（截止 Hz）或 `{cutoffHz, resonance, lfoHz, lfoDepth}`；默认无 |
| `delay` | `{steps, feedback, mix}`，按 step 计时的轨道延迟；loop 中延迟不短于一圈时按循环折叠，song 中超过歌曲长度则为静音；默认无 |

- 音符：`C4`、`F#3`、`Bb2`；范围 C1-C8。
- 力度：`C4:4@6`，0-7；写 `@6~slide` 或 `~slide@6` 都可以。
- 效果：`slide`、`vibrato`、`drop`、`fadein`、`fadeout`、`arpfast`、`arpslow`。`slide(n)` / `vib(depth[,rateHz])` 可带参数。
- 门限：`C4:4g2` 占 4 步、只响 2 步（staccato）；`C4:4g6` 响 6 步，会盖住下一格（legato）。省略 `g` 时门限等于占位长度。
- 和弦：`[C4,E4,G4]:4` 或命名和弦 `Cmaj7`、`Fm/E`，最多 4 个音；和弦级 `@力度`/`~效果` 作用于所有声部。
- 每个 track 先渲染到自己的 buffer，再做滤波、延迟、duck、pan 和 send，最后求和；所以这些参数互不串轨。
- `swing`：0-0.5，奇数 step 延后 `swing * stepSeconds`；同一输入渲染确定。
- 每个 pattern 会重复填满 `bars`；四拍一小节，循环长度 = `bars * 4 * stepsPerBeat` 步。
- 单轨可写和弦，最多 4 个同时发声的声部；需要更多层时用多条 track。鼓轨的 one-shot 独立渲染，尾音可以和后续 hit 重叠。

### 和弦、包络与效果参数

命名和弦在解析时展开成 midi，渲染路径与显式和弦完全一致：

```json
"pattern": "Cmaj7:4 Fm:4 Fm/E:4 G7/B:4 F3m7:8 Db3maj7:8"
```

- 品质：`maj`（在 `C/E`、`{C}` 这类强制和弦写法里可省略）、`m`/`min`、`dim`、`aug`、`sus2`、`sus4`、`5`、`6`、`m6`、`7`、`maj7`、`m7`、`m7b5`、`dim7`、`7sus4`、`add9`、`9`、`maj9`、`m9`。
- 八度：默认根音 4；可以写在品质前或后，如 `F3m7` / `Fm3`（根音 F3）、`Cmaj74`（根音 C4）。
- 斜杠低音：`Fm/E`、`G7/B`；不写八度时低音放在根音下一个八度。四音和弦加斜杠会省掉五音，保留三音、七音和延伸音。
- `C7`、`C5`、`C6`、`C9` 与音名（八度）冲突，裸写会被当成音名；需要这些数字品质时加大括号：`{C7}`、`{C9}`。`G7/B` 因为有斜杠，可以裸写。

命名包络放在顶层 `envelopes`，用 `~名字` 引用；一个 token 最多一个 `~效果` 和一个 `~包络`：

```json
{
  "envelopes": { "pluck": { "attack": 0.002, "decay": 0.07, "sustain": 0.08, "release": 0.03 } },
  "tracks": [{ "pattern": "C4:4~pluck C4:4~vib(0.4,6) C4:4~slide(0.5)" }]
}
```

- 包络名不能与效果名冲突（`vibrato`、`slide` 等）。
- `vib(depth)`：颤音深度 0-2 半音，默认 0.5；`vib(depth, rateHz)` 速率 0.1-20 Hz，默认 7.5。
- `slide(steps)`：滑音在多少 step 内到达目标，0.05-8，默认 1。
- 没有参数时，`slide`、`vibrato` 的行为与之前完全一致。

`seed` 只影响 noise 波形和鼓的噪声瞬态，不改变音高、时值或旋律；同一 seed 渲染确定。

### 动机与变换

顶层或 track 内定义 `motifs`，pattern 用 `@名字` 引用：

```json
{
  "motifs": {
    "lead_call": "F4:1 Ab4:1 C5:1 Ab4:1",
    "phrase_A": "@lead_call @lead_call.transpose(2)"
  },
  "tracks": [{ "pattern": "@phrase_A @phrase_A.invert @phrase_A.retrograde" }]
}
```

- `transpose(n)`：移调 -24..24 半音。
- `invert`：围绕动机第一个有声部做倒影。
- `retrograde`：反序。
- `augment(n)` / `diminish(n)`：时值放大/缩小 2-8 倍；`diminish` 要求所有 slot 和 gate 都能被整除。
- 变换从左到右链式执行；动机可嵌套，带循环检测。鼓动机支持反序和时值变换，`transpose`/`invert` 会报错。
- 和弦 token 可以作为动机内容，但 `transpose`/`invert` 暂不支持含和弦的动机。

### 鼓

把 `role` 设为 `drums`，pattern 直接写鼓 token：

| token | 声音 |
| --- | --- |
| `K` | kick |
| `S` | snare |
| `H` | closed hat |
| `O` | open hat |
| `C` | clap |
| `T` | tom |
| `R` | rim（必须大写；小写 `r` 仍是休止） |
| `X` | crash |

也接受 `kick`、`snare`、`open-hat`、`rim` 等全名。单字母 token 大小写不敏感，只有小写 `r` 仍是休止、大写 `R` 是 rim。鼓轨渲染时忽略 `waveform` 和 `envelope`，每个 hit 有独立的瞬态包络；`@力度` 改变 hit 的振幅。

### Song 模式

```json
{
  "mode": "song",
  "bpm": 165,
  "patterns": {
    "drums.B": "K:1 H:1 S:1 H:1",
    "bass.B": "F1:1 F1:1 C2:1 F1:1 D#2:1 F1:1 C2:1 A#1:1"
  },
  "tracks": [
    { "name": "drums", "role": "drums", "pattern": "K:1 -:1 H:1 -:1" },
    { "name": "bass", "role": "bass", "waveform": "tilted_saw", "pattern": "F1:1 F1:1 C2:1 F1:1" }
  ],
  "arrangement": [
    { "name": "intro", "bars": 4, "mute": ["drums", "bass"], "filter": 1200 },
    { "name": "build", "bars": 4, "patterns": { "drums": "drums.B" } },
    { "name": "drop", "bars": 8, "gain": 1.05, "patterns": { "bass": "bass.B" } },
    { "name": "break", "bars": 4, "mute": ["drums"], "filter": 600 }
  ]
}
```

- `arrangement` 存在时 `mode` 默认 `song`；`bars` 由各 section 的 `bars` 相加得到，也可以显式写出，但必须一致。
- 每个 section 的长度应当是所用 pattern 长度的整数倍；否则解析器仍按旧行为截断最后一遍，并在报告里写 `pattern-misaligned` 警告。loop 模式也会对不整除 loop 的 pattern 给出同样警告。
- 一次渲染的 arrangement 总量上限是 15 分钟和 256 个 section；最终输出（包括降速后）也以 15 分钟为硬上限，超出会直接报错，而不是分配一个不可控的缓冲区。
- `patterns` 可以放在顶层，也可以放在 track 内；section 的 `patterns` 用 track 的 `name` 或 `role` 指向 pattern 名。也可以直接写内联 pattern（如 `C4:4 C4:4`，或单 token `C4`）；已定义的 pattern 名优先。
- section 字段：`bars`（必填）、`patterns`、`mute`、`gain`、`gains`、`filter`。
- `filter` 是该段的低通截止频率（Hz）；写成 `{"from":600,"to":12000}` 时在整个 section 内指数扫频，`from` 到 `to` 单调上升就是 riser 的滤波部分；`mute` 接受 track 的 `name` 或 `role`。
- song 模式渲染整首一次，忽略 `minutes`；需要紧结尾时用 `post: []`。

### 混音与空间

- `pan` 用等功率声像，居中时左右都是 1.0，保持旧 score 的音量。
- `filter`：`cutoffHz` 100-20000；`resonance`（别名 `q`）0.5-20；`lfoHz` 0-20，`lfoDepth` 0-4 个八度。LFO 调制截止频率，适合 acid bass 和缓慢移动的 pad。
- `delay`：`steps` 1-64，`feedback` 0-0.95，`mix` 0-1。loop 模式会先跑 3 遍再取最后一遍，延迟尾巴在循环接缝处连续；延迟不短于一圈时按循环长度折叠，不会变成静音。song 模式中超过歌曲长度的延迟还没到达，因此是静音。
- `duck`：所有鼓轨的 kick 都会触发；每轨独立深度，启动约 5 ms、释放约 110 ms。
- `send`：所有开 send 的轨道汇入一条 mono send 总线，经过一个独立混响后加回干声；它发生在 `post` 链之前，因此会跟随 `tape`/`lowpass` 一起被处理。
- `post` 里的 `reverb` 仍是总线混响；`send` 和它不是互斥的，可以叠加。

### Post 链

`post` 显式给出后处理链；`[]` 表示干声。省略时用 `preset`：

```json
"post": [
  { "type": "tape", "speed": 0.8 },
  { "type": "lowpass", "cutoffHz": 7000 },
  { "type": "reverb", "wet": 0.4, "room": 0.9, "damp": 0.5 }
]
```

- 步骤按数组顺序执行；`tape` / `lowpass` 作用于左右声道，`reverb` 先把输入下混成 mono 再输出 stereo。
- `tape` / `slow`：`speed` 0.5-1.5，降速同时降音高；多个降速步骤会串联相乘。
- `lowpass`：`cutoffHz`（或别名 `toneHz`）100-22050。
- `reverb`：`wet`、`room`、`damp`。
- `tilt`：`tiltDb` -12..12，700 Hz 上下的倾斜 EQ；正值更亮，负值更暗。
- `saturate`：`drive`、`mix` 0-1，tanh 软饱和，压峰并把安静段落补厚。
- `compress`：`thresholdDb`（默认 -18）、`ratio`（默认 2）、`attack` / `release`（秒）、`makeupDb`。立体声联动，检波器跟左右声道中较响的一侧。
- `loudness`：`targetLufs` -40..-5（默认 -14），按 BS.1770 积分响度整体加/减增益。通常放在 `limiter` 之前。
- `limiter`：`ceilingDb`（默认 -1）、`release`（默认 0.1 s）。瞬时启动、指数恢复，保证没有样本超过 ceiling。
- `preset` 仍可用：`classic`、`dreamy`、`tape`。`speed` / `wet` / `toneHz` 是 post 的快捷覆盖；有对应步骤时改该步骤，没有时补一个。`speed` 作用于整条 tape/slow 链：第一个步骤取目标速度，后续 tape/slow 设为 1，所以链的总速度等于 `speed`。`room` / `damp` 直接写在 `reverb` 步骤里。
- `style` 只填 post 链的默认值：`chip`（`post: []` 干声）、`hitech`（饱和 + glue 压缩 + -14 LUFS + limiter）、`ambient`（slow 0.8 + lowpass + reverb + limiter）。`style` 不改变 `mode` 和 score；和显式 `preset` 同时出现会报错，显式 `post` 仍然优先。
- loop 模式下，带混响时会先跑 3 个循环再取最后一个稳态循环；取最后一圈时从缓冲区末尾回退 `loopSamples`，避免重采样取整造成补零。干声只跑 1 个循环。轨道 `send` 的 send 总线也按同样方式取稳态。

### 输出

loop 模式默认 2 分钟，WAV 由整数个循环单元重复而成，首尾可直接无缝循环。各轨求和后用共享增益把峰值压到 -1 dBFS 以下，多轨满音量也不会削波。song 模式输出整首一次。

### 渲染报告与 `p8_analyze`

每次 `p8_music` 都会在路径和参数之后返回一份报告，模型不用再盲写：

```
report peak -1.0 dBFS · RMS -14.1 dBFS · LUFS -12.2
report spectrum centroid 3625 Hz · sub 4% low 19% mid 35% high 24% air 19%
report space width 0.25 · onsets 25.3/s
report sections intro -18.0 dBFS · drop -10.0 dBFS
report warnings: dark: 1% above 2 kHz; narrow: width 0.02; sparse: 0.9 onsets/s
```

- peak / RMS / LUFS：整段音频（loop 取循环本体，song 取整首）。
- 频谱：2048 样本（约 46 ms）帧的幅度谱质心与 sub/low/mid/high/air 占比，最多抽样 48 帧；不是 4 秒窗。宽度、峰值、RMS 和 LUFS 使用全部样本。
- 空间与节奏：side/mid RMS 比（0 是单声道，1 是硬声像）和 onset 密度。
- sections：song 模式每段的 RMS。
- warnings：`dark`（2 kHz 以上太少）、`narrow`（几乎单声道）、`sparse`（瞬态太少）、`low-heavy`（250 Hz 以下超过 70%）、`quiet` / `loud`、`flat-sections`（段落能量差小于 2 dB）、`trimmed`（峰值安全网下拉超过 3 dB）。

`p8_analyze` 对已有 WAV 做同一套测量，不需要重新渲染：

```json
{ "path": "loop.wav" }
```

它只接受 16-bit PCM WAV（本插件自己的输出），其它格式会给出明确错误。

## 开发

```bash
node --version     # >= 22.18，直接运行 .ts
npm test           # 运行全部测试
npm run typecheck  # tsc --noEmit
npm run check      # 边界检查 + 类型检查 + 测试
```

测试和 `npm run check` 通过 Node 原生类型擦除直接运行 `src/` 的 TS；分发给不运行 TS 的宿主时用 `npm run build` 生成 `dist/`。构建启用了 TypeScript 的 `rewriteRelativeImportExtensions`，所以源码里的 `.ts` 相对导入会变成 `.js`，不需要手改。`package.json` 仍是 `private: true`；要发布到 npm 必须先去掉 `private`。DSH 0.2 读取 `package.json.dsh`（`manifestVersion: 1` + `bundle.patch`），不再有单独的 `dsh-plugin.json`。

## 已知限制

- 只实现 8 种内置波形；PICO-8 的自定义乐器波形没有对应的 score 表示。
- PICO-8 在这里是音色与编曲风格，不是硬件复刻：单轨和弦加 legato 可以同时超过 4 个声部，输出是 44.1 kHz 立体声，而不是 22050 Hz / 4 单声部通道。没有严格 `pico` 模式。
- 效果是音乐语义的近似，不是 PICO-8 sfx 状态机的逐样本复刻。
- 鼓是合成瞬态，不是采样；没有 roll / flam / ghost 参数。
- M2 和声/发音法已做：显式与命名和弦、斜杠低音、gate、swing、命名 per-note 包络、参数化 slide/vibrato、seed。暂不做 `key`/`scale` 度数记谱、voice leading、参数化 arp、humanize、tuplet；三连音需要分数 step 网格，成本高于收益。
- M3 已做：per-track filter（带 LFO/共振）、段落滤波扫频（riser/sweep 的滤波部分）、pan、send、duck（kick 触发）、step 计时 delay。暂不做：unison、任意 sidechain 源、独立的 riser/impact/sub-drop 采样 FX。
- M4 已做：渲染报告（peak/RMS/LUFS/频谱/宽度/onset/分段/警告）、`p8_analyze`、`tilt`/`saturate`/`compress`/`loudness`/`limiter` 五个 master 步骤、`chip`/`hitech`/`ambient` 三个 style。limiter 与最后的共享峰值安全网是两层：limiter 负责声音，安全网只防止 16-bit 削波。
- song 模式的 `send` 混响和 `post` 混响尾音都会在歌曲结束时截断；需要干净收尾时把 `send` 设为 0 并使用 `post: []`。
- `limiter` 按样本峰值工作，不做 4× 过采样，所以它是 sample-peak 而不是严格的 true-peak limiter；44.1 kHz 的 WAV 上两者差距通常小于 0.5 dB。
- 循环长为整数采样；`speed` 不是整数比时会有一点点有效速度偏差（< 0.01%）。
- 渲染在工具调用内同步完成；loop 默认 2 分钟在本机约 3 秒，机器相关，更长请先控制 `minutes`。合成、混音和分块写文件都会检查 abort，但单个 DSP 步骤（如整段 reverb）仍可能运行数秒才返回。
- `out` / `p8_analyze` 的 `path` 都被限制在工作目录内，并且输出必须是 `.wav`；这条边界由插件服务层自己执行，不依赖宿主是否检查 manifest。
- 15 分钟是最终输出（含 `tape` 降速后的长度）的硬上限。`executeRender` 不再一次性编码整段 WAV，而是按 16384 帧分块写文件；渲染阶段仍会同时持有循环/歌曲样本和中间后处理缓冲，内存随长度线性增长。
- `p8_analyze` 只接受 16-bit PCM；报告里的 peak 是 sample peak，不是 true peak。
