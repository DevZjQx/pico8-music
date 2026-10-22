# pico8-music

DSH / Pi 插件：模型用 JSON 作曲，插件默认合成 PICO-8 风格的声音，输出 44.1 kHz 立体声 WAV；需要别的音色时用 `instrument` 换成 additive/FM 音源：additive 可以用谐波振幅 + 相位自己设计波形，也可以用 `stretch` 做非谐钟声、`tilt` 压暗、逐谐波衰减做拨弦，或者把工作区里的 WAV 采样素材作为音源。支持两种模式：

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
    render/                  # 合成、乐器、鼓、轨道混音、滤波、后处理、稳态循环、WAV
docs/expressiveness-review.md      # 表现力审查：从慢速混响循环到可编曲的引擎
docs/evaluation.md           # 曲目评分维度：频谱/瞬态/空间/和声/结构/响度
docs/design-boundaries.md    # 设计边界与风险：产品、模块、兼容、资源
docs/features/               # 两个 feature 的边界决策
examples/m1-16bar.json       # 16 小节 intro/build/drop/break 示例
examples/motifs.json         # motif / phrase 变换示例
examples/m2-chords-gate-swing.json # 和弦、gate、swing 示例
examples/m2.5-harmony-envelope.json # 命名和弦、命名包络、效果参数示例
examples/m3-space-motion.json # pan/send/duck/filter LFO/delay/段落扫频示例
examples/m6-instruments.json # 命名 instrument、additive/FM、鼓参数示例
examples/m7-wave-shapes.json # 模型自己设计的波形：脉冲、相位阶梯、反向锯齿
examples/m8-samples.json   # 工作区 WAV 采样：sample 音源 + 鼓声替换
examples/m9-additive-textures.json # additive 非谐、tilt、逐谐波衰减：钟声/拨弦/暗垫
examples/assets/           # m8 引用的 16-bit PCM WAV 素材
scripts/check-boundaries.ts  # shared -> features -> app 的零依赖检查
test/
```

## 安装

```bash
bun install
bun run build                 # 产物在 dist/，prepack 也会自动构建
dsh plugin --profile web add /path/to/pico8-music
# 或 bun pm pack，再安装生成的 pico8-music-0.0.1.tgz
```

重启对应 profile，模型就会看到 `p8_music` 工具。插件 id 是 `pico8-music`；如果装过旧 id，先移除再重新 add。DSH 从 `package.json.dsh`（`manifestVersion: 1` 与 `bundle.patch`）读取 bundle，入口是 `dist/app/dsh-plugin.js`；Pi 入口是 `dist/app/pi-extension.js`。

## 帮助文本：`/p8m` 与 `p8_help`

PICO-8 乐谱 DSL 的完整说明不再塞进工具描述里（那会让每个会话、每次请求都带上约 3.4 KB 的乐器说明）。它只存在一处：`src/features/score/help.ts` 的 `SCORE_HELP`，两种宿主都按需读取：

| | Pi | DSH |
| --- | --- | --- |
| 人手动看 | `/p8m`，作为 custom message 写进会话，人和模型都能看到 | `/p8m` 命令，结果由 UI 渲染 |
| 模型自己看 | `p8_help` 工具 | `p8_help` 工具 |

`p8_analyze` 是配套的自检工具，两种宿主都有；它只读 WAV，不写文件。

- `p8_music` 的描述只留一句简短说明并指向 `p8_help`；`score` / `scoreFile` 解析失败时错误信息也会提示去调用 `p8_help`。
- DSH 的命令结果按宿主约定只走 UI、不进模型历史（`@deepseek-ai/dsh-commands`："命令结果永不成为模型消息"），所以 DSH 侧模型读帮助只能靠 `p8_help` 工具；Pi 侧 `/p8m` 会额外写进上下文，因为 Pi 的 custom message 会参与下一轮请求。
- DSH 的 `commands` 是可选服务（headless 宿主没有命令面），插件用 `ctx.inject(['commands'], …)` 注册命令，不把它写进 `inject` 数组，否则没有命令面的宿主会连工具都不启动。

代价对比：改之前常驻约 4.4 KB（当时约 2.4 KB 的说明 + 1.6 KB 参数 schema + snippet/guidelines）；现在三个工具的参数 schema 合计 Pi 3119 B、DSH 2584 B（JSON 字节，不含描述与会话格式开销），8694 B 的 `SCORE_HELP` 只在真正查看帮助时才进上下文。instrument 说明只进帮助文本，没有进工具描述。两个宿主的工具参数来自同一份 `src/app/tool-schemas.ts`，不再各写一遍。

## 调用

```json
{
  "score": "{\"mode\":\"song\",\"bpm\":165,\"patterns\":{\"drums.B\":\"K:1 H:1 S:1 H:1\"},\"tracks\":[{\"name\":\"drums\",\"role\":\"drums\",\"pattern\":\"K:1 -:1 H:1 -:1 S:1 -:1 H:1 -:1\"}],\"arrangement\":[{\"name\":\"intro\",\"bars\":4,\"mute\":[\"drums\"]},{\"name\":\"drop\",\"bars\":4,\"patterns\":{\"drums\":\"drums.B\"}}]}",
  "post": [],
  "out": "loop.wav"
}
```

也可以把手写的 score 放进工作区里的 JSON 文件，用 `scoreFile` 引用：

```json
{
  "scoreFile": "examples/m1-16bar.json",
  "out": "m1.wav"
}
```

`score` 是 JSON 字符串，不是嵌套对象：这样在 DSH 和 Pi 两种宿主的参数校验下行为一致。`scoreFile` 是相对工作区的路径，省略 `.json` 后缀时自动补上，每次渲染都会重新读取文件；`score` 和 `scoreFile` 只能给一个。`post`、`preset`、`style`、`speed`、`wet`、`toneHz`、`minutes`、`out` 都是 `p8_music` 工具参数，和 `score` / `scoreFile` 平级；不要写进 score JSON，否则会报 `unknown field` 并提示它们属于工具参数。更多示例见 `examples/m1-16bar.json`、`examples/motifs.json`、`examples/m2-chords-gate-swing.json`、`examples/m2.5-harmony-envelope.json`、`examples/m3-space-motion.json`、`examples/m5-drums-fill.json`、`examples/m6-instruments.json`、`examples/m7-wave-shapes.json`、`examples/m8-samples.json`、`examples/m9-additive-textures.json`。

### Loop 模式

| 字段 | 范围 | 默认 |
| --- | --- | --- |
| `mode` | `loop` / `song` | 没有 `arrangement` 时为 `loop` |
| `bpm` | 30-300 | 90 |
| `stepsPerBeat` | 1-8 整数 | 4 |
| `beatsPerBar` | 1-16 整数；3 表示 3/4，6 配 `stepsPerBeat:2` 表示 6/8 | 4 |
| `bars` | 1-64 整数（song 模式的 section 也是 1-64，可选总 `bars` 为 1-256） | 4 |
| `swing` | 0-0.5 | 0 |
| `humanize` | `{timingMs:0-50, velocity:0-1}`；确定性时序/力度扰动，0 不改变旧渲染 | 关闭 |
| `tail` | 0-15 秒，song 模式在最后一步后多渲染一段让混响和 one-shot 收尾 | 0 |
| `seed` | 0-2147483647 整数，影响 noise 音色、鼓瞬态、humanize 与段落 riser | 0 |
| `motifs` | 可选，命名动机：`{"A":"C4:1 E4:1"}` | 空 |
| `envelopes` | 可选，命名 ADSR：`{"pluck":{"attack":0.001,...}}` | 空 |
| `tracks` | 1-32 个；每条轨是独立总线，轨数由编曲需要决定 | 必填 |
| `samples` | 可选，命名 WAV 素材：`{"hit":"assets/hit.wav"}` 或 `{"vox":{"file":"assets/vox.wav","root":"C4","loop":false,"gain":1}}` | 空 |
| `drumSamples` | 可选，按鼓声替换素材：`{"kick":"hit","snare":"hit2"}`；没映射的鼓仍用合成音 | 空 |

每个 track：

| 字段 | 说明 |
| --- | --- |
| `name` | 可选，段落覆盖时用；默认 `track0`、`track1`… |
| `role` | 可选，`drums`、`bass`、`lead`、`pad` 等；默认 `melodic` |
| `pattern` | 必填（或提供 `patterns`）。`音符:步数[g门限]` 用空格分隔，`-` 是休止；可选后缀 `@力度`、`~效果`、`~包络` |
| `patterns` | 可选，本轨的命名 pattern：`{"A":"...","B":"..."}` |
| `motifs` | 可选，本轨的命名动机；同名时覆盖顶层 `motifs` |
| `waveform` | `0-7` 或 `triangle`、`tilted_saw`、`saw`、`square`、`pulse`、`organ`、`noise`、`phaser`，默认 `pulse`；只在没有 `instrument` 或 chip instrument 时生效 |
| `instrument` | 可选，顶层 `instruments` 里的名字、内联定义，或 `chip`/`fm`/`additive`/`drums`，也可以引用 `samples` 里的素材；显式写入时优先于 style 的 role 默认值 |
| `volume` | 0-7（可带一位小数），默认 5。没有 `@力度` 的音符用它 |
| `envelope` | 可选 ADSR：`{attack, decay, sustain, release}`，单位秒（`sustain` 是 0-1 电平） |
| `pan` | -1（左）..1（右），默认 0；等功率，居中不改变音量 |
| `send` | 0-1，送入轨道混响 send；默认 0 |
| `duck` | 0-1，被鼓轨 kick 触发的压低深度；默认 0 |
| `filter` | 数字（截止 Hz）或 `{cutoffHz, resonance, lfoHz, lfoDepth}`；默认无 |
| `delay` | `{steps, feedback, mix}`，按 step 计时的轨道延迟；loop 中延迟不短于一圈时按循环折叠，song 中超过歌曲长度则为静音；默认无 |

- 音符：`C4`、`F#3`、`Bb2`；范围 C1-C8。
- 力度：`C4:4@6`，0-7，可带一位小数（`@4.5`）；写 `@6~slide` 或 `~slide@6` 都可以。
- 效果：`slide`、`vibrato`、`drop`、`fadein`、`fadeout`、`arpfast`、`arpslow`。`slide(n)` / `vib(depth[,rateHz])` 可带参数。鼓轨不用这些效果，改用 `~ghost` / `~flam` / `~roll`（见下文）。
- 门限：`C4:4g2` 占 4 步、只响 2 步（staccato）；`C4:4g6` 响 6 步，会盖住下一格（legato）。省略 `g` 时门限等于占位长度。
- 和弦：`[C4,E4,G4]:4` 或命名和弦 `Cmaj7`、`Fm/E`，最多 4 个音；和弦级 `@力度`/`~效果` 作用于所有声部。
- 每个 track 先渲染到自己的 buffer，再做滤波、延迟、duck、pan 和 send，最后求和；所以这些参数互不串轨。
- 未知字段会直接报错，不会被静默忽略：`pan`、`send`、`duck`、`filter`、`delay` 都是 track 的平铺字段，不要写成 `"mix": {...}`。
- 不写 `instrument` 时走原来的 8 波形路径，逐样本不变；写 `instrument` 才换发声器。
- `swing`：0-0.5，奇数 step 延后 `swing * stepSeconds`；同一输入渲染确定。
- `humanize`：`timingMs` 让每个事件有 ±N 毫秒的确定性偏移，`velocity` 让力度有 ±50% 的确定性起伏；两者都由 `seed` 和事件位置决定，loop 内每个 pass 完全一致。默认 0，旧 score 逐样本不变。
- `tail`：只在 song 模式有效，在最后一个 step 之后多渲染 N 秒（最多 15 秒），让 send/post 混响和鼓的 one-shot 自然收尾；loop 模式禁止 `tail`，否则会破坏无缝循环。
- 每个 pattern 会重复填满 `bars`；每小节 `beatsPerBar` 拍（默认 4），循环长度 = `bars * beatsPerBar * stepsPerBeat` 步。
- 单轨可写和弦，最多 4 个同时发声的声部；一条 track 是一个编曲声部/总线，和弦声部不要各占一条轨。需要更多层次时增加 track。鼓轨的 one-shot 独立渲染，尾音可以和后续 hit 重叠。

### 和弦、包络与效果参数

命名和弦在解析时展开成 midi，渲染路径与显式和弦完全一致：

```json
"pattern": "Cmaj7:4 Fm:4 Fm/E:4 G7/B:4 F3m7:8 Db3maj7:8"
```

- 品质：`maj`（在 `C/E`、`{C}` 这类强制和弦写法里可省略）、`m`/`min`、`dim`、`aug`、`sus2`、`sus4`、`5`、`6`、`m6`、`7`、`maj7`、`m7`、`m7b5`、`dim7`、`7sus4`、`add9`、`9`、`maj9`、`m9`。
- 八度：默认根音 4；可以写在品质前或后，如 `F3m7` / `Fm3`（根音 F3）、`Cmaj74`（根音 C4）。
- 斜杠低音：`Fm/E`、`G7/B`；不写八度时低音放在根音下一个八度。四音和弦加斜杠会优先省掉五音；没有五音（如 `C9/E`）时省掉根音，保留三音、七音和延伸音。
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

`seed` 影响 noise 波形、鼓的噪声瞬态、humanize 的时序/力度扰动与段落 riser 的噪声，不改变音高、时值或旋律；同一 seed 渲染确定。

### 乐器（instrument）

顶层 `instruments` 表放命名音色，track 用 `"instrument": "名字"` 引用；也可以直接写内联对象。三种类型：

| 类型 | 必填/可选字段 | 声音 |
| --- | --- | --- |
| `chip` | `waveform` | 原来的 8 个 PICO-8 波形，逐样本兼容 |
| `additive` | `partials`：1-16 个谐波，第 1 个是基频；元素是振幅 `0-1`、负振幅（同一形状镜像）、`[振幅, 相位度数]` 或 `[振幅, 相位度数, 衰减秒数]`；另外可选 `stretch` 0-1（非谐）和 `tilt` 0-4（压暗） | 默认按音符频率做带限波表并峰值归一化；`stretch` 或逐谐波衰减时改为逐 partial 合成。模型可以用 `partials` 自己设计波形（25% 占空比脉冲、阶梯谐波），也可以用 `stretch` 做钟/金属、用逐谐波衰减做拨弦/电钢 |
| `fm` | `ratio` 0.25-8、`index` 0-12、`indexDecay` 0.01-4 秒 | 两算子相位调制，电钢/钟/贝斯类音色 |

三种类型共用：`unison` 1-4、`detune` 0-50 音分、`drive` 0-1，以及逐音滤波包络 `filter: {cutoffHz, resonance, envAmount, attack, decay, sustain, release}`；`envAmount` 是截止频率被包络推开的八度数（0-6）。

```json
{
  "instruments": {
    "pad": { "type": "additive", "partials": [1, 0.6, 0.35, 0.2, 0.12], "unison": 3, "detune": 9,
             "filter": { "cutoffHz": 2400, "envAmount": 1.4, "attack": 0.4, "decay": 1, "sustain": 0.6 } },
    "bell": { "type": "fm", "ratio": 3, "index": 2.4, "indexDecay": 0.6, "drive": 0.1 }
  },
  "tracks": [
    { "role": "pad", "instrument": "pad", "pattern": "[C4,E4,G4]:8" },
    { "role": "lead", "instrument": "bell", "pattern": "C5:2 E5:2 G5:2" }
  ]
}
```

- 不写 `instrument` 时仍走 `waveform` 的旧路径；写 `instrument: {"type":"chip","waveform":"saw"}` 与直接写 `waveform: "saw"` 渲染结果逐样本相同。
- 显式 `track.instrument` 优先于 style 的 role 默认音色；没有匹配的 role 时用 style 的 `default`。
- `style: "studio"` 与 `style: "lofi"` 会按 role（`bass`、`lead`、`pad`、`keys`、`default`）填入非芯片音色，所以同一份 score 换 style 就能离开芯片听感。
- 谐波按音符频率带限，高音不会像朴素锯齿那样叠混叠；FM 不做过采样。
- `partials` 是分数里的数字，不是外部波形文件：负振幅等价于 `[振幅, 180]`，相位让模型能做只有相位才能表达的波形（占空比脉冲、非对称/阶梯形状）。换相位只移动形状、不移动电平，因为电平锚定在实测峰值。完整示例见 `examples/m7-wave-shapes.json`。
- `stretch` 让第 n 个谐波跑在 `n·f0·√(1+stretch·(n²−1))`：基频保持音准，高次谐波变尖，0 是普通谐波列，0.2-0.5 接近钟/金属。`tilt` 把第 n 个谐波乘上 `n^-tilt`，适合不写 `partials`、只把默认的 1/n 谐波列压暗。
- 逐谐波衰减写作 `[振幅, 相位度数, 秒数]`，是 `exp(-t/秒数)` 的时间常数；0 或省略表示不衰减。高次谐波先死适合钟、拨弦、电钢。
- 没有 `stretch`、也没有任何逐谐波衰减时仍走原来的波表路径，旧 score 逐样本不变。出现两者之一时改为逐 partial 合成：仍按音符带限、仍把初始峰值锚在 0.25，但每个 partial 每采样一次 `sin`，所以适合 lead/pad/bell，不适合 8 声部以上的密集和弦。
- 不做数学公式/表达式音源：周期公式与 `partials` 表达力重叠，非周期音色用 `samples`（工作区脚本生成任意 WAV）质量更高；这里只加数值参数。完整示例见 `examples/m9-additive-textures.json`。

### 采样素材（samples）

`instruments` 解决的是“合成什么音色”，`samples` 解决的是“复用一段已经存在的 WAV”。素材文件放在工作区里，score 只保存引用，所以素材和 `scoreFile` 一样会持久化；每次渲染都会重新核对文件，进程内再按 `path + size + mtime` 缓存解码后的 PCM。

```json
{
  "samples": {
    "hit": "assets/hit.wav",
    "vox": { "file": "assets/vox.wav", "root": "A3", "loop": true, "gain": 0.8 }
  },
  "instruments": {
    "choir": { "type": "sample", "sample": "vox" }
  },
  "drumSamples": { "kick": "hit", "snare": "hit" },
  "tracks": [
    { "name": "choir", "instrument": "choir", "pattern": "A3:8 C4:8" },
    { "name": "drums", "role": "drums", "pattern": "K:1 -:1 S:1 -:1" }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `file` | 必填，工作区相对路径，必须以 `.wav` 结尾；不能是绝对路径或包含 `..` 逃出工作区 |
| `root` | 可选，素材原速播放时的音名，默认 `C4`；音符相对它做变速，不改变音色长度以外的语义 |
| `loop` | 可选，`true` 时素材在 gate 内循环；默认 `false`，到文件结尾就停 |
| `gain` | 可选，0-4 的线性增益，默认 1 |

- 只接受 16-bit PCM WAV（mono/stereo）。stereo 会先平均成 mono，再进入轨道 pan/send/filter；这与 `p8_analyze` 的解码器是同一套，不引入 ffmpeg 或额外编解码依赖。
- 每个素材最长 30 秒、文件最大 32 MB、最多 16 个；上限是渲染预算，不是音乐规则。
- 素材路径相对于**工作区根目录**，不是 `scoreFile` 所在目录。`scoreFile` 每次重读，素材也每次按文件状态重新校验；文件被替换后下一次渲染就会用新内容。
- `instrument: {"type":"sample","sample":"名字"}` 只接受 `type` 和 `sample`，不接受 `waveform`/`partials`/`stretch`/`tilt`/`unison`/`drive`/`filter`；需要滤波时用 track 级 `filter`。
- 每个音符都从素材开头播放；`~slide`、`~vibrato`、`~arpfast/arpslow` 通过改变播放速度生效。`~fadein`/`~fadeout`、track/named envelope 仍然作用在采样输出的增益上。
- 鼓映射是逐声替换：`~pitch` 改播放速度，`~tone` 加低通，`~flam`/`~roll` 与 `~ghost` 的力度/低通继续生效；`~decay`（包括 `~ghost` 的缩短衰减）对采样没有等价语义，会被忽略。鼓素材永远按 one-shot 播放，即使素材写了 `loop: true`，也不会无限循环。
- 未使用的 `samples` 也会被读取和校验：这样路径写错时会在渲染前失败，而不是等到某条轨第一次发声。错误信息会带上素材名、路径和解码原因。

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

也接受 `kick`、`snare`、`open-hat`、`rim` 等全名。单字母 token 大小写不敏感，只有小写 `r` 仍是休止、大写 `R` 是 rim。鼓轨渲染时忽略 `waveform`、`envelope` 和 `instrument`，每个 hit 有独立的瞬态包络；`@力度` 改变 hit 的振幅。`drumSamples` 可以把某个鼓声换成 `samples` 里的 WAV；没映射的鼓声继续用合成瞬态。

鼓的发音法写在 token 的 `~` 后缀上；一个 token 只能带一个鼓效果，但可以叠加音高/衰减/音色参数：

| 写法 | 行为 |
| --- | --- |
| `K:1~ghost` | 力度降到 45%，衰减更短，并加 4.5 kHz 低通；适合 ghost note |
| `S:1~flam` / `S:1~flam(24)` | 在 16 ms（可设 5-40 ms）后再打一下，第二下力度 45% |
| `K:2~roll4` / `K:2~roll(4)` | 在 slot 内均分 4 次（2-8），力度逐次递减；`~roll` 默认 4 次 |

鼓参数可以单独用，也可以跟在 `~ghost` / `~flam` / `~roll` 后面，按任意顺序、每种最多一次：

| 写法 | 行为 |
| --- | --- |
| `K:1~pitch(-2)` | 有音高的鼓体移调 -12..12 半音；噪声成分不变 |
| `S:1~decay(1.5)` | 衰减速率乘 0.25..4；和 `~ghost` 同时出现时相乘 |
| `H:1~tone(3000)` | hit 后接 200-16000 Hz 低通；会覆盖 `~ghost` 的 4.5 kHz |

鼓效果和参数可以和 `@力度`、`g` 门限、motif 的 retrograde/augment/diminish 一起用；`~ghost`、`~pitch` 等不能写在休止上，也不能用在旋律轨。

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
- section 字段：`bars`（必填）、`patterns`、`mute`、`gain`、`gains`、`filter`、`energy`、`fill`、`riser`。
- `riser`：1-64 小节，不能超过所在 section 的长度；在这一段末尾合成一条噪声 + 正弦上行扫频，正好结束在段落边界，用作 build/转场的上扬。它不占 track，声音由 `seed` 决定。
- `energy`：0-1 的段落宏。0 时该段增益 ×0.5，若有 `filter` 则截止频率 ×0.35；1（默认）不改变任何东西，所以旧 score 不受影响。适合写 intro/break 的“收”。
- `fill`：`{"bars":1,"patterns":{"drums":"drums.fill"}}`，用指定 pattern 替换该 section 最后 1-2 小节的普通 pattern；`patterns` 的键可以是 track 的 `name` 或 `role`。fill pattern 长度不整除 fill 窗口时会在报告里给出 `fill-misaligned` 警告。
- `filter` 与 `energy` 可以叠加：滤波先按 section 扫频，再乘 energy 的截止系数；`gain`/`gains` 也在 energy 之后相乘。
- `filter` 是该段的低通截止频率（Hz），作用于干声和 send 总线的输入；写成 `{"from":600,"to":12000}` 时在整个 section 内指数扫频，`from` 到 `to` 单调上升就是 riser 的滤波部分；`mute` 接受 track 的 `name` 或 `role`。
- song 模式渲染整首一次，忽略 `minutes`；需要紧结尾时用 `post: []` 并把 track `send` 设为 0。需要尾音时设置顶层 `tail`（秒），混响和 one-shot 会继续响完，最后 20 ms 淡出避免截断爆音。

### 混音与空间

- `pan` 用等功率声像，居中时左右都是 1.0，保持旧 score 的音量。
- `filter`：`cutoffHz` 100-20000；`resonance`（别名 `q`）0.5-20；`lfoHz` 0-20，`lfoDepth` 0-4 个八度。LFO 调制截止频率，适合 acid bass 和缓慢移动的 pad。
- `delay`：`steps` 1-64，`feedback` 0-0.95，`mix` 0-1。loop 模式会先跑 3 遍再取最后一遍，延迟尾巴在循环接缝处连续；延迟不短于一圈时按循环长度折叠，不会变成静音。song 模式中超过歌曲长度的延迟还没到达，因此是静音。
- `duck`：所有鼓轨的 kick 都会触发；每轨独立深度，启动约 5 ms、释放约 110 ms。
- `send`：所有开 send 的轨道汇入一条 mono send 总线，经过一个独立混响后加回干声；它发生在 `post` 链之前，因此会跟随 `tape`/`lowpass` 一起被处理。
- `post` 里的 `reverb` 仍是总线混响；`send` 和它不是互斥的，可以叠加。

### Post 链

`post` 是 `p8_music` 的工具参数（不在 score JSON 里），显式给出后处理链；`[]` 表示不跑 post 链，但轨道 `send` 仍按混音设置生效——要完全干声再设 `send: 0`。省略时用 `preset`：

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
- `style` 填默认值：`chip`（`post: []`，无 post 处理）、`hitech`（饱和 + glue 压缩 + -14 LUFS + limiter）、`ambient`（slow 0.8 + lowpass + reverb + limiter），以及 `studio` / `lofi`（各自的 post 链 + 非芯片的 role 音色）。`style` 不改变 `mode` 和 score；和显式 `preset` 同时出现会报错，显式 `post` 仍然优先，显式 `track.instrument` 优先于 style 音色。
- loop 模式下，带混响时会先跑 3 个循环再取最后一个稳态循环；取最后一圈时从缓冲区末尾回退 `loopSamples`，避免重采样取整造成补零。干声只跑 1 个循环。轨道 `send` 的 send 总线也按同样方式取稳态。

### 输出

loop 模式默认 2 分钟，WAV 由整数个循环单元重复而成，首尾可直接无缝循环。各轨求和后用共享增益把峰值压到 -1 dBFS 以下，多轨满音量也不会削波。song 模式输出整首一次。16-bit 转换前加 2 LSB 峰峰值的 TPDF 抖动（三角分布噪声），把量化误差变成约 −96 dBFS 的平坦噪声，而不是和信号相关的失真谐波；抖动序列由固定种子生成，所以同一份 score 的任何两次渲染仍然逐字节相同，流式分块写文件也与一次性编码一致。

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
- warnings：`dark`（2 kHz 以上太少）、`narrow`（几乎单声道）、`sparse`（瞬态太少）、`low-heavy`（250 Hz 以下超过 70%）、`quiet` / `loud`、`flat-sections`（段落能量差小于 2 dB）、`pattern-misaligned` / `fill-misaligned`（pattern 截断）、`trimmed`（峰值安全网下拉超过 3 dB）。

`p8_analyze` 对已有 WAV 做同一套测量，不需要重新渲染：

```json
{ "path": "loop.wav" }
```

它只接受 16-bit PCM WAV（本插件自己的输出），其它格式会给出明确错误。

## 开发

```bash
bun --version      # >= 1.2，直接运行 .ts
bun test           # 运行全部测试
bun run typecheck  # tsc --noEmit
bun run check      # 边界检查 + 类型检查 + 测试
```

工具链只有 bun 一条：`bun.lock` 是唯一的锁文件（不再有 `package-lock.json`），`bun install` 后 `src/` 的 TS 直接运行，不需要编译步骤。`bun run build` 才调 `tsc` 生成 `dist/`，用于不运行 TS 的宿主；构建启用了 TypeScript 的 `rewriteRelativeImportExtensions`，所以源码里的 `.ts` 相对导入会变成 `.js`，不需要手改。`package.json` 仍是 `private: true`；要发布到 npm 必须先去掉 `private`。DSH 0.2 读取 `package.json.dsh`（`manifestVersion: 1` + `bundle.patch`），不再有单独的 `dsh-plugin.json`。

## 已知限制

- 音源有四类：8 个内置 chip 波形、带限 additive 谐波（静态波表或逐 partial 合成）、两算子 FM，以及工作区里的 16-bit PCM WAV 素材。采样只做线性插值变速和可选的整段循环，不做切片、反向、多采样映射或 wavetable；`root` 之外没有 per-zone 映射。物理建模仍不做。
- PICO-8 在这里是音色与编曲风格，不是硬件复刻：单轨和弦加 legato 可以同时超过 4 个声部，输出是 44.1 kHz 立体声，而不是 22050 Hz / 4 单声部通道。没有严格 `pico` 模式。
- 效果是音乐语义的近似，不是 PICO-8 sfx 状态机的逐样本复刻。
- 鼓默认是合成瞬态；`drumSamples` 可以按声替换成 WAV，`~ghost` 的力度/低通、`~flam`/`~roll` 与 per-hit `~pitch`/`~tone` 仍生效，但采样鼓的 `~decay`（含 ghost 的缩短衰减）会被忽略，也没有逐 hit 滤波包络。
- M2 和声/发音法已做：显式与命名和弦、斜杠低音、gate、swing、命名 per-note 包络、参数化 slide/vibrato、seed。仍不做 `key`/`scale` 度数记谱与 voice leading：命名和弦已覆盖大部分和声写法，voice leading 需要跨段和声状态且验收主观。
- M3 已做：per-track filter（带 LFO/共振）、段落滤波扫频、pan、send、duck（kick 触发）、step 计时 delay。M8 追加了独立的段落 `riser`、`tail` 与 `humanize`；仍不做任意 sidechain 源和 impact/sub-drop 采样 FX。
- M4 已做：渲染报告（peak/RMS/LUFS/频谱/宽度/onset/分段/警告）、`p8_analyze`、`tilt`/`saturate`/`compress`/`loudness`/`limiter` 五个 master 步骤。
- M6 已做：命名/内联 `instruments`（chip / additive / FM）、unison 失谐、drive、逐音滤波包络、鼓的 per-hit pitch/decay/tone、`studio`/`lofi` 两个换音色的 style。采样素材（`samples` / `drumSamples`）已支持 16-bit PCM WAV；仍不做切片/多采样映射/任意波表、任意 FM 算子矩阵、per-note pan。
- additive 扩展已做：`stretch` 非谐、`tilt` 频谱倾斜、逐谐波衰减；静态路径逐样本兼容。仍不做公式/表达式音源、任意 FM 算子矩阵和波表文件。
- 轨数上限是 32，不是音乐规则：每条轨都要一整段 buffer 和一次逐样本混音，所以长歌 + 很多轨会明显变慢。需要更多层次时优先增加 track，而不是把和弦塞到 8 个声部以上。
- `humanize` 只改时序和力度，不做 probability/ratchet；`tuplet` 仍不做：三连音需要分数 step 网格，会同时影响 parser、swing、段落对齐和循环接缝，收益低于成本。
- song 模式的 `send` 混响和 `post` 混响尾音默认会在歌曲结束时截断；设置顶层 `tail` 可以留出收尾时间，或用 `send: 0` + `post: []` 做紧结尾。
- `limiter` 按样本峰值工作，不做 4× 过采样，所以它是 sample-peak 而不是严格的 true-peak limiter；44.1 kHz 的 WAV 上两者差距通常小于 0.5 dB。
- 循环长为整数采样；`speed` 不是整数比时会有一点点有效速度偏差（< 0.01%）。
- 渲染在工具调用内同步完成；loop 默认 2 分钟在本机约 3 秒，机器相关，更长请先控制 `minutes`。合成、混音和分块写文件都会检查 abort，但单个 DSP 步骤（如整段 reverb）仍可能运行数秒才返回。
- `out` / `p8_analyze` 的 `path` 都以宿主会话的工作区为根（DSH 取 `exec.agent.session.header.cwd`，Pi 取 `ctx.cwd`），而不是插件进程的 `process.cwd()`；只有宿主不给会话目录时才回退到进程目录。路径必须留在该工作区内，并且输出必须是 `.wav`；这条边界由插件服务层自己执行，不依赖宿主是否检查 manifest。
- 15 分钟是最终输出（含 `tape` 降速后的长度）的硬上限。`executeRender` 不再一次性编码整段 WAV，而是按 16384 帧分块写文件；渲染阶段仍会同时持有循环/歌曲样本和中间后处理缓冲，内存随长度线性增长。
- `p8_analyze` 只接受 16-bit PCM；报告里的 peak 是 sample peak，不是 true peak。
