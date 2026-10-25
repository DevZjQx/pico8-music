# pico8-music

DSH / Pi 插件：模型用 JSON 作曲，插件默认合成 PICO-8 风格的声音，输出 44.1 kHz 立体声 WAV；需要别的音色时用 `instrument` 换成 additive/FM 音源：additive 可以用谐波振幅 + 相位自己设计波形，也可以用 `stretch` 做非谐钟声、`tilt` 压暗、逐谐波衰减做拨弦；FM 可以走经典两算子或固定路由的多算子；工作区里的 WAV 采样可以剪区域、反向、设循环点，也可以按音区和力度分层。支持两种模式：

- `loop`：一条 pattern 循环，可选降速、低通、混响，输出无缝循环。
- `song`：用 `arrangement` 拼出 intro / build / drop / break，渲染完整结构。

不需要 PICO-8、ffmpeg 或 sox 等外部二进制；运行时依赖只有 `typebox`（用于 Pi 工具参数校验）。插件本身不绑定特定的 DSH profile。

## 目录

```
.agents/skills/pico8-songwriter/SKILL.md  # 作曲指南（随包分发；DSH 运行时注册，Pi 读 pi.skills）
src/
  app/dsh-plugin.ts          # 组合层：注册 p8_music / p8_export 工具与技能、写文件
  app/pi-extension.ts        # Pi 适配层：p8_music / p8_export / p8_probe / p8_help 工具 + /p8m 命令
  app/skill.ts               # 读取 SKILL.md、拆 frontmatter，供 DSH 注册 runtime skill
  features/
    score/                   # 作曲格式、段落、鼓 token、音符/和弦解析、校验、DSL 线格式、时间线展开
    structure/               # 符号结构读数：每小节密度、旋律熵/音程/重复、音区重叠、低音走向与调性
    render/                  # 合成、乐器、鼓、轨道混音、滤波、后处理、稳态循环、音色探针、报告、WAV
    musicxml/                # 未压缩 MusicXML 4.0 partwise：小节网格、和弦、连线、鼓记谱、段落变速
docs/expressiveness-review.md      # 表现力审查：从慢速混响循环到可编曲的引擎
docs/evaluation.md           # 曲目评分维度：频谱/瞬态/空间/和声/结构/响度
docs/analysis-roadmap.md     # 分析反馈 M1-M3：stem 归因、post delta、findings、raw artifact
docs/features/structure.md   # 符号结构读数：每小节密度、旋律运动/重复、音区重叠、低音与调性
docs/features/musicxml.md    # 未压缩 MusicXML 导出：小节/和弦/连线/鼓记谱/调律的映射取舍
docs/expectation-theory.md   # 期待/情绪研究的取舍：哪些能变成读数、哪些不能当验收标准
docs/space-energy-plan.md    # 空间与能量弧线：P0 已实施（space/width/段落读数），P1-P2 计划
docs/design-boundaries.md    # 设计边界与风险：产品、模块、兼容、资源
docs/features/               # 四个 feature（score / structure / render / musicxml）的边界决策
examples/m1-16bar.json       # 16 小节 intro/build/drop/break 示例
examples/motifs.json         # motif / phrase 变换示例
examples/m2-chords-gate-swing.json # 和弦、gate、swing 示例
examples/m2.5-harmony-envelope.json # 命名和弦、命名包络、效果参数示例
examples/m3-space-motion.json # pan/send/duck/filter LFO/delay/段落扫频示例
examples/m6-instruments.json # 命名 instrument、additive/FM、鼓参数示例
examples/m7-wave-shapes.json # 模型自己设计的波形：脉冲、相位阶梯、反向锯齿
examples/m8-samples.json   # 工作区 WAV 采样：sample 音源 + 鼓声替换
examples/m9-additive-textures.json # additive 非谐、tilt、逐谐波衰减：钟声/拨弦/暗垫
examples/m10-tuning.json      # A=442、钢琴式 Railsback 逐音 cents 与 additive 钢琴音色
examples/m11-velocity-timbre.json # 力度映射到滤波 cutoff 与 drive：重音更亮
examples/m14-articulations-presets.json # 可复用演奏法（spiccato/legato）与音色预设（violin/viola）
examples/m15-groups-stereo-send.json # 鼓/键盘分组、组级滤波与各自的立体声混响返回
examples/m16-timbral-depth.json # 采样区域/分层、多算子 FM、力度到 FM index
examples/m17-key-harmony.json  # 声明调 key：报告读低音弧线、在调内占比与变化音
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

重启对应 profile，模型就会看到 `p8_music` / `p8_export` 工具。插件 id 是 `pico8-music`；如果装过旧 id，先移除再重新 add。DSH 从 `package.json.dsh`（`manifestVersion: 1` 与 `bundle.patch`）读取 bundle，入口是 `dist/app/dsh-plugin.js`；Pi 入口是 `dist/app/pi-extension.js`。

## 技能：`pico8-songwriter`

作曲指南只存在一份：`.agents/skills/pico8-songwriter/SKILL.md`，随包分发（`files` 里包含 `.agents/skills`），装好插件两个宿主都能看到：

| | Pi | DSH |
| --- | --- | --- |
| 来源 | `package.json.pi.skills` 指向 `./.agents/skills` | `dist/app/dsh-plugin.js` 启动时读取同一个文件，用 `ctx.skills.register(...)` 注册成 runtime skill |
| 为什么不能只靠扫描 | 包内 `.agents/skills` 目录不在 cwd 祖先链上 | `dsh-skill-filesystem` 只扫 project/custom/user 根，明确忽略包清单和嵌套目录 |

在本仓库里开发时不需要装插件：Pi 和 DSH 都会把 `<repo>/.agents/skills` 当作项目技能根。`ctx.skills` 与 `ctx.commands` 一样是可选服务，用 `ctx.inject(['skills'], …)` 注册；没有技能注册表的 headless 宿主照常只拿到工具。SKILL.md 缺失或 frontmatter 不合法时只打一条 warning，不影响工具注册。

**职责划分：** `SKILL.md` 负责「怎么写曲」——选型（loop / song）、小节与网格、轨道布局、鼓与和声的选择、段落设计、混音决策、读报告改曲的循环；`p8_help`（`src/features/score/help.ts`）只负责「线格式」——字段名、token 语法、范围、默认值、会报错/警告的情况。技能里不再复制字段表，遇到没写到的字段就让模型去调 `p8_help`；两边交叉引用，不重复正文。

## 帮助文本：`/p8m` 与 `p8_help`

PICO-8 乐谱 DSL 的线格式说明不再塞进工具描述里（那会让每个会话、每次请求都带上约 3.4 KB 的乐器说明）。它只存在一处：`src/features/score/help.ts` 的 `SCORE_HELP`，两种宿主都按需读取（作曲部分在上面的 `pico8-songwriter` 技能里，两边不重复）：

| | Pi | DSH |
| --- | --- | --- |
| 人手动看 | `/p8m`，作为 custom message 写进会话，人和模型都能看到 | `/p8m` 命令，结果由 UI 渲染 |
| 模型自己看 | `p8_help` 工具 | `p8_help` 工具 |

`p8_analyze` 是成品 WAV 的自检工具，`p8_probe` 是单乐器音色的受控探针，`p8_export` 把同一份 score 写成未压缩 MusicXML；两种宿主都有。`p8_analyze` 默认只读 WAV，`p8_probe` 默认只渲染一个干声单音，两者的 `detail: "raw"` 都会在工作区写一份 JSON。

- `p8_music` 的描述只留一句简短说明并指向 `p8_help`；`score` / `scoreFile` 解析失败时错误信息也会提示去调用 `p8_help`。
- DSH 的命令结果按宿主约定只走 UI、不进模型历史（`@deepseek-ai/dsh-commands`："命令结果永不成为模型消息"），所以 DSH 侧模型读帮助只能靠 `p8_help` 工具；Pi 侧 `/p8m` 会额外写进上下文，因为 Pi 的 custom message 会参与下一轮请求。
- DSH 的 `commands` 是可选服务（headless 宿主没有命令面），插件用 `ctx.inject(['commands'], …)` 注册命令，不把它写进 `inject` 数组，否则没有命令面的宿主会连工具都不启动。

代价对比：改之前常驻约 4.4 KB（当时约 2.4 KB 的说明 + 1.6 KB 参数 schema + snippet/guidelines）；现在五个工具的参数 schema 合计约 Pi 13 KB、DSH 12 KB（JSON 字节，不含描述与会话格式开销），`SCORE_HELP` 只在真正查看帮助时才进上下文。instrument 说明只进帮助文本，没有进工具描述。两个宿主的工具参数来自同一份 `src/app/tool-schemas.ts`，不再各写一遍。

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

`score` 是 JSON 字符串，不是嵌套对象：这样在 DSH 和 Pi 两种宿主的参数校验下行为一致。`scoreFile` 是相对工作区的路径，省略 `.json` 后缀时自动补上，每次渲染都会重新读取文件；`score` 和 `scoreFile` 只能给一个。`post`、`preset`、`style`、`quality`、`width`、`monoBelowHz`、`target`、`assert`、`speed`、`wet`、`toneHz`、`minutes`、`out` 都是 `p8_music` 工具参数，和 `score` / `scoreFile` 平级；不要写进 score JSON，否则会报 `unknown field` 并提示它们属于工具参数。更多示例见 `examples/m1-16bar.json`、`examples/motifs.json`、`examples/m2-chords-gate-swing.json`、`examples/m2.5-harmony-envelope.json`、`examples/m3-space-motion.json`、`examples/m5-drums-fill.json`、`examples/m6-instruments.json`、`examples/m7-wave-shapes.json`、`examples/m8-samples.json`、`examples/m9-additive-textures.json`、`examples/m12-soft.json`、`examples/m13-tempo-sections.json`、`examples/m16-timbral-depth.json`。

### Loop 模式

| 字段 | 范围 | 默认 |
| --- | --- | --- |
| `mode` | `loop` / `song` | 没有 `arrangement` 时为 `loop` |
| `bpm` | 30-300；loop 模式的唯一速度，也是 song 模式每个 section 的默认速度 | 90 |
| `stepsPerBeat` | 1-8 整数 | 4 |
| `beatsPerBar` | 1-16 整数；3 表示 3/4，6 配 `stepsPerBeat:2` 表示 6/8 | 4 |
| `bars` | 1-64 整数（song 模式的 section 也是 1-64，可选总 `bars` 为 1-256） | 4 |
| `swing` | -0.5..0.5；正数延后奇数 step，负数提前 | 0 |
| `humanize` | `{timingMs:0-150, velocity:0-1}`；确定性时序/力度扰动，0 不改变旧渲染 | 关闭 |
| `tuning` | 可选，整曲调律：`{a4, temperament, cents}`；`a4` 400-480 Hz，`temperament` 是内置律制，`cents` 逐音 -100..100 音分 | 440 Hz 十二平均律 |
| `key` | 可选，声明的调：`"C"`、`"Am"`、`"F# minor"`、`"Bbm"`（字母 + 可选 #/b + 可选 maj/major/min/minor）；只影响报告的调性读数，不改变发声 | 无；没有 `key` 就没有“在调内占比” |
| `tail` | 0-30 秒，song 模式在最后一步后多渲染一段让混响和 one-shot 收尾 | 0 |
| `inheritSections` | 布尔；为 true 时，省略 `bpm`、`patterns`、`mute`、`gain`、`gains`、`filter`、`energy`、`space`、`width`、`tracks` 的 section 继承上一段的值 | false |
| `seed` | 0-2147483647 整数，影响 noise 音色、鼓瞬态、humanize 与段落 riser | 0 |
| `motifs` | 可选，命名动机：`{"A":"C4:1 E4:1"}` | 空 |
| `envelopes` | 可选，命名 ADSR：`{"pluck":{"attack":0.001,...}}` | 空 |
| `articulations` | 可选，可复用演奏法：`{"spiccato":{"gateScale":0.45,"volume":5,"envelope":"short"}}`，token 用 `~spiccato` 引用 | 空 |
| `presets` | 可选，可复用音色预设：`{"violin":{"instrument":"strings","envelope":{...},"articulation":"legato","send":0.2}}`，track 用 `"preset":"violin"` 引用 | 空 |
| `groups` | 可选，命名分组/子混音：`{"drums":{"gain":0.9,"pan":0.1,"send":0.2,"reverb":{"room":0.8}}}`，track 用 `"group":"drums"` 加入；`buses` 是同义词 | 空 |
| `tracks` | 1-32 个；每条轨是独立总线，轨数由编曲需要决定 | 必填 |
| `samples` | 可选，命名 WAV 素材：`{"hit":"assets/hit.wav"}` 或 `{"vox":{"file":"assets/vox.wav","root":"C4","loop":false,"gain":1}}` | 空 |
| `drumSamples` | 可选，按鼓声替换素材：`{"kick":"hit","snare":"hit2"}`；没映射的鼓仍用合成音 | 空 |

每个 track：

| 字段 | 说明 |
| --- | --- |
| `name` | 可选，段落覆盖时用；默认 `track0`、`track1`… |
| `role` | 可选，`drums`、`bass`、`lead`、`pad` 等；默认 `melodic` |
| `preset` | 可选，引用顶层 `presets` 里的音色预设；只填音色/包络/演奏法/混音默认值，不填 role 或 pattern |
| `group` | 可选，引用顶层 `groups` 里的分组（别名 `bus`）；组内轨道先合成一个立体声子混音，再走组级 gain/pan/filter/delay/duck/send |
| `pattern` | 必填（或提供 `patterns`）。`音符:步数[g门限]` 用空格分隔，`-` 是休止；发声音符的步数 1-64，休止可到 1-256 步（用于填充 pattern），门限 1-256 步；可选后缀 `@力度`、`~效果`、`~包络` |
| `patterns` | 可选，本轨的命名 pattern：`{"A":"...","B":"..."}` |
| `motifs` | 可选，本轨的命名动机；同名时覆盖顶层 `motifs` |
| `waveform` | `0-7` 或 `triangle`、`tilted_saw`、`saw`、`square`、`pulse`、`organ`、`noise`、`phaser`，默认 `pulse`；只在没有 `instrument` 或 chip instrument 时生效 |
| `instrument` | 可选，顶层 `instruments` 里的名字、内联定义，或 `chip`/`fm`/`additive`/`drums`，也可以引用 `samples` 里的素材；显式写入时优先于 style 的 role 默认值 |
| `volume` | 0-7（可带一位小数），默认 5。没有 `@力度` 的音符用它 |
| `envelope` | 可选 ADSR：`{attack, decay, sustain, release}`，attack/decay/release 为 0-30 秒（`sustain` 是 0-1 电平） |
| `articulation` | 可选，本轨默认演奏法名；token 自己的 `~名字` 优先 |
| `pan` | -1（左）..1（右），默认 0；等功率，居中不改变音量 |
| `send` | 0-1，送入这条轨的立体声混响返回（有 group 时是组返回，否则是默认返回）；也可写 `{amount, bus}` 指定别的组返回，或 `{stereo:false}` 回到旧的 pre-pan mono send；默认 0 |
| `duck` | 0-1，被鼓轨 kick 触发的压低深度；默认 0 |
| `filter` | 数字（截止 Hz）或 `{cutoffHz, resonance, lfoHz, lfoDepth}`；默认无 |
| `highpassHz` | 20-4000 Hz，12 dB/oct 高通；只作用于这条轨，用来单独挖掉某条轨的浑浊，默认无 |
| `lowShelf` | `-24..24` dB（写在 250 Hz）或 `{hz, gainDb}`；低架 EQ，默认无 |
| `highShelf` | `-24..24` dB（写在 4000 Hz）或 `{hz, gainDb}`；高架 EQ，默认无 |
| `delay` | `{steps, feedback, mix, follow}`，按 step 计时的轨道延迟；`follow` 默认 `"base"`（按顶层 bpm），设为 `"section"` 时回声落在哪个段落就按哪个段落的 bpm 计时；loop 中延迟不短于一圈时按循环折叠，song 中超过歌曲长度则为静音；默认无 |

- 音符：`C4`、`F#3`、`Bb2`；范围 C1-C8。
- 力度：`C4:4@6`，0-7，可带一位小数（`@4.5`）；写 `@6~slide` 或 `~slide@6` 都可以。力度先乘振幅；如果乐器写了 `velocity` 映射，它还会驱动滤波 cutoff 和 drive（见“乐器”）。
- 效果：`slide`、`vibrato`、`drop`、`fadein`、`fadeout`、`arpfast`、`arpslow`。`slide(n)` / `vib(depth[,rateHz])` 可带参数。鼓轨不用这些效果，改用 `~ghost` / `~flam` / `~roll`（见下文）。
- 门限：`C4:4g2` 占 4 步、只响 2 步（staccato）；`C4:4g6` 响 6 步，会盖住下一格（legato）。省略 `g` 时门限等于占位长度。
- 和弦：`[C4,E4,G4]:4` 显式 voicing 最多 8 个音；命名和弦 `Cmaj7`、`Fm/E` 最多展开成 4 个音；和弦级 `@力度`/`~效果` 作用于所有声部。
- 每个 track 先渲染到自己的 buffer，再做滤波、延迟、duck、pan 和 send，最后求和；所以这些参数互不串轨。
- 未知字段会直接报错，不会被静默忽略：`pan`、`send`、`duck`、`filter`、`delay` 都是 track 的平铺字段，不要写成 `"mix": {...}`。
- 不写 `instrument` 时走原来的 8 波形路径，逐样本不变；写 `instrument` 才换发声器。
- `swing`：-0.5..0.5，奇数 step 偏移 `swing * stepSeconds`（正数延后、负数提前，最多半格）；同一输入渲染确定。
- `humanize`：`timingMs` 让每个事件有 ±N 毫秒的确定性偏移，`velocity` 让力度有 ±50% 的确定性起伏；这两项都会由 `seed` 和事件位置决定，loop 内每个 pass 完全一致。默认 0，旧 score 逐样本不变。当乐器启用 `velocity` 映射时，humanize 的力度起伏也会一起改变音色。
- `tail`：只在 song 模式有效，在最后一个 step 之后多渲染 N 秒（最多 30 秒），让 send/post 混响和鼓的 one-shot 自然收尾；loop 模式禁止 `tail`，否则会破坏无缝循环。
- 每个 pattern 会重复填满 `bars`；每小节 `beatsPerBar` 拍（默认 4），循环长度 = `bars * beatsPerBar * stepsPerBeat` 步。
- 单轨可写显式和弦，最多 8 个同时发声的声部；一条 track 是一个编曲声部/总线，和弦声部不要各占一条轨。需要更多层次时增加 track。鼓轨的 one-shot 独立渲染，尾音可以和后续 hit 重叠。

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

### 调律（tuning）

`tuning` 是整曲的音高参考，不改变音色。`a4` 是 A4 的绝对频率（400-480 Hz，默认 440），也是所有算法的锚点：律制表以 A 为 0 点，所以只换 `temperament` 不会移动 A4；其余音按律制移动，再叠加 `cents` 的逐音微调（-100..100 音分）。如果给 `A4` 本身写了 `cents`，它会在 `a4` 之上再偏移。

```json
{
  "tuning": {
    "a4": 442,
    "temperament": "equal",
    "cents": { "C1": -28, "C2": -18, "C3": -9, "C4": 0, "C5": 8, "C6": 18, "C7": 28, "C8": 38 }
  },
  "tracks": [{ "pattern": "C4:4 E4:4 G4:4" }]
}
```

- `temperament`：`equal`（默认）、`just`（5 限纯律）、`pythagorean`、`meantone`（四分之一音差）、`werckmeister3`、`kirnberger3`、`young`。也接受 `werckmeister-iii`、`quarter-comma-meantone` 等常见写法。
- `cents` 的键是音名（`C4`、`F#3`、`Bb2`），值是相对该律制音高的音分偏移；同一个 MIDI 音只能用一种写法，`C4` 和 `B#3` 同时出现会报错。
- 上面的 `cents` 是一条简化的钢琴 Railsback 曲线：低音区偏低、高音区偏高，配合 `additive` 的 `stretch` 和逐谐波衰减可以做出接近钢琴的调律与音色。完整示例见 `examples/m10-tuning.json`。
- 调律在解析时算进每个 `NoteEvent.frequency`，所以所有发声路径（chip、additive、FM、采样）都跟随；`unison` 的 `detune` 仍然是叠加在调律之后的群感展宽。
- 采样音源通过改变播放速度跟随目标频率，因此逐键 `cents` 对采样钢琴同样有效；每个 zone 指向的素材都有自己的 `root`，但 `root` 仍按素材自身的 A4=440 十二平均律解释，没有 per-zone 独立调律。

### 乐器（instrument）

顶层 `instruments` 表放命名音色，track 用 `"instrument": "名字"` 引用；也可以直接写内联对象。三种类型：

| 类型 | 必填/可选字段 | 声音 |
| --- | --- | --- |
| `chip` | `waveform` | 原来的 8 个 PICO-8 波形，逐样本兼容 |
| `additive` | `partials`：1-16 个谐波，第 1 个是基频；元素是振幅 `0-1`、负振幅（同一形状镜像）、`[振幅, 相位度数]` 或 `[振幅, 相位度数, 衰减秒数]`；另外可选 `stretch` 0-1（非谐）和 `tilt` 0-4（压暗） | 默认按音符频率做带限波表并峰值归一化；`stretch` 或逐谐波衰减时改为逐 partial 合成。模型可以用 `partials` 自己设计波形（25% 占空比脉冲、阶梯谐波），也可以用 `stretch` 做钟/金属、用逐谐波衰减做拨弦/电钢 |
| `fm` | 经典两算子：`ratio` 0.25-8、`index` 0-12、`indexDecay` 0.01-4 秒；或多算子：`operators` 为 1-3 个 `{ratio, index, indexDecay, target}`，`target` 只能是更低的算子（0 是载波） | 相位调制。两算子适合电钢/钟/贝斯；多算子用固定路由（链式或并联）做更复杂的金属、铜管和演化音色 |

三种类型共用：`unison` 1-4、`detune` 0-50 音分、`drive` 0-1，以及逐音滤波包络 `filter: {cutoffHz, resonance 0.05-20, envAmount, attack, decay, sustain, release}`；`envAmount` 是截止频率被包络推开的八度数（0-6）。

`chip` / `additive` / `fm` 还可以写 `velocity: {cutoffOctaves: 0-6, drive: 0-1, indexScale: 0-1}`：不写或全为 0 时行为不变；写了以后，`@力度`（含 humanize 的力度起伏）会按归一化力度把 `filter.cutoffHz` 最多打开 N 个八度，并把额外 drive 叠到基础 `drive` 上。`cutoffOctaves` 需要同时有 `filter`，否则解析报错；`drive` 不依赖 filter。`indexScale` 只用于 FM：0 保持 index 不变，1 让零力度时的 index 归零，所以轻声自然变暗。`sample` 乐器不接受 `velocity`。完整示例见 `examples/m11-velocity-timbre.json` 与 `examples/m16-timbral-depth.json`。

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
- 多算子 FM 的 `operators` 替代 `ratio`/`index`/`indexDecay`，不能和它们同时写。每个算子只有一个输出目标，且只能指向更低的编号，所以没有反馈环、也不需要拓扑排序：一个算子指向 0 就是直接调制载波，指向 1 就是调制第一个调制器。只写一个算子时，渲染结果与经典两算子逐样本相同。
- 显式 `track.instrument` 优先于 style 的 role 默认音色；没有匹配的 role 时用 style 的 `default`。
- `style: "studio"` 与 `style: "lofi"` 会按 role（`bass`、`lead`、`pad`、`keys`、`default`）填入非芯片音色，所以同一份 score 换 style 就能离开芯片听感。
- 谐波按音符频率带限，高音不会像朴素锯齿那样叠混叠；FM 不做过采样。
- `partials` 是分数里的数字，不是外部波形文件：负振幅等价于 `[振幅, 180]`，相位让模型能做只有相位才能表达的波形（占空比脉冲、非对称/阶梯形状）。换相位只移动形状、不移动电平，因为电平锚定在实测峰值。完整示例见 `examples/m7-wave-shapes.json`。
- `stretch` 让第 n 个谐波跑在 `n·f0·√(1+stretch·(n²−1))`：基频保持音准，高次谐波变尖，0 是普通谐波列，0.2-0.5 接近钟/金属。`tilt` 把第 n 个谐波乘上 `n^-tilt`，适合不写 `partials`、只把默认的 1/n 谐波列压暗。
- 逐谐波衰减写作 `[振幅, 相位度数, 秒数]`，是 `exp(-t/秒数)` 的时间常数；0 或省略表示不衰减。高次谐波先死适合钟、拨弦、电钢。
- 没有 `stretch`、也没有任何逐谐波衰减时仍走原来的波表路径，旧 score 逐样本不变。出现两者之一时改为逐 partial 合成：仍按音符带限、仍把初始峰值锚在 0.25，但每个 partial 每采样一次 `sin`，所以适合 lead/pad/bell，不适合 8 声部以上的密集和弦。
- 不做数学公式/表达式音源：周期公式与 `partials` 表达力重叠，非周期音色用 `samples`（工作区脚本生成任意 WAV）质量更高；这里只加数值参数。完整示例见 `examples/m9-additive-textures.json`。

### 演奏法与音色预设（articulations / presets）

把重复的发音方式和音色写成数据，而不是在每条 track 上反复展开：

```json
{
  "envelopes": { "short": { "attack": 0.01, "decay": 0.08, "sustain": 0.05, "release": 0.04 } },
  "articulations": {
    "spiccato": { "gateScale": 0.45, "volume": 5, "envelope": "short", "effect": "vibrato", "effectParams": { "vibratoDepth": 0.12 } },
    "legato": { "gateScale": 1.5, "effect": "vibrato", "effectParams": { "vibratoDepth": 0.22, "vibratoRate": 5.2 } }
  },
  "instruments": {
    "strings": { "type": "additive", "partials": [1, 0.62, 0.44, 0.3, 0.22], "unison": 2, "detune": 5 }
  },
  "presets": {
    "violin-lead": { "instrument": "strings", "articulation": "legato", "volume": 5, "pan": -0.15, "send": 0.22, "highpassHz": 140 }
  },
  "tracks": [
    { "role": "lead", "preset": "violin-lead", "pattern": "C5:2~spiccato D5:2~spiccato E5:2~legato" }
  ]
}
```

- `articulations` 的字段：`gateScale`（0.05-8，乘 slot 后取整到 1-256 步）、`volume`（0-7）、`envelope`（内联 ADSR 或顶层 `envelopes` 的名字）、`effect`（一个 pitched effect）和 `effectParams`（vibrato 用 `{vibratoDepth, vibratoRate}`，slide 用 `{slideSteps}`）。
- token 自己的 `gGATE`、`@volume`、`~effect` 优先于 articulation；track 的 `articulation` 是没有 `~名字` 的 token 的默认值。
- articulation 名与 envelope 名、effect 名、鼓词汇互斥，保证 `~名字` 只有一种解释；命名 articulation 只用于旋律轨，鼓仍用 `~ghost`/`~flam`/`~roll`。
- `presets` 的字段：`instrument`、`waveform`、`envelope`、`articulation`、`volume`、`pan`、`send`、`duck`、`filter`、`highpassHz`、`lowShelf`、`highShelf`、`delay`。track 上显式写的字段优先于 preset。
- score 里的 `presets` 不是 `p8_music` 的 `preset` 工具参数：后者只选 `classic`/`dreamy`/`tape` 后处理链，且必须写在 score 外面。preset 也不保存 role 或 pattern。

完整示例见 `examples/m14-articulations-presets.json`。

### 分组、总线与立体声 send

当前 send 不是一条 mono 总线：轨道按自己的 pan 把左右信号分别送进返回，所以硬左的轨道混响也留在左边。`groups` 再把多条轨合成一个子混音，每组拥有自己的返回和混响参数，鼓组、键盘组可以各自用不同的 room/damp，不再共享同一个混响。

```json
{
  "groups": {
    "drums": { "gain": 1.05, "send": 0.12, "reverb": { "room": 0.72, "damp": 0.6 } },
    "keys": { "pan": 0.15, "send": 0.45, "reverb": { "room": 0.92, "damp": 0.32, "predelayMs": 24 }, "highpassHz": 120 }
  },
  "tracks": [
    { "name": "kick", "role": "drums", "group": "drums", "pattern": "K:2 H:2 S:2 H:2" },
    { "name": "keys", "role": "keys", "group": "keys", "pattern": "[F3,A3,C4]:8", "send": 0.2 }
  ]
}
```

- `groups` 字段：`gain` 0-4、`pan` -1..1、`send` 0..1、`duck` 0..1、`filter`、`highpassHz`、`lowShelf`、`highShelf`、`delay`、`reverb`（`{room, damp, predelayMs, lowCutHz, highCutHz, modDepth, modRateHz}`）；这些混响字段也可以直接写在组上。中性默认是 `gain:1`、`pan:0`、`send:0`、`duck:0`、无滤波/延迟/混响。
- 组内轨道先做各自的滤波、EQ、delay、duck、pan、send，再求和成组缓冲；组级处理在这个和上做一次，所以组滤波器、组 delay、组 duck 不会逐轨重复。
- 组级 `send` 送的是处理完的组输出；组内轨道自己的 `send` 也进同一个组返回，并跟随源组的 gain/pan（组拉小或搬到一边，send 一起走），因此可以既保留单轨 send 深度，又用 `group.send` 统一加湿。没有 `group` 的轨道走默认返回。
- `send` 除了数字还可以写 `{"amount":0.4,"bus":"hall"}`：干声仍走自己的 group，但 send 进 `hall` 的返回；`{"amount":0.4,"stereo":false}` 回到旧的 pre-pan mono send（左右相同），用于需要旧行为的场合。旧 score 若同时写了 `pan` 和 `send`，混响位置会和以前不同；要逐样本复现旧 send，加 `stereo:false`。
- `group`/`bus` 是同义词：顶层 `groups`/`buses`、track `group`/`bus`。同一份 score 只用一种拼写；未知组名在解析期报错。
- 段落 `space` 会乘到所有立体声 send（默认返回和每个组返回），段落 `tracks.<name>.send` 对有组的轨道仍然有效。

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
| `start` / `end` | 可选，秒数；只播放文件中的这一段，`end` 不包含在区间内。用来切 break、取单周期波表片段或跳过前奏的静音 |
| `reverse` | 可选，`true` 时把选中的区域反向播放；循环点会跟着一起镜像 |
| `loopStart` / `loopEnd` | 可选，秒数；循环区间，必须配合 `loop: true`。不从区间外开始，播放仍从区域开头进入，到达 `loopEnd` 后才跳回 `loopStart` |
| `zones` | 可选，分键/分层映射：`[{sample, lo, hi, velLo, velHi}]`。此时不能同时写 `file` |

- 只接受 16-bit PCM WAV（mono/stereo）。stereo 会先平均成 mono，再进入轨道 pan/send/filter；这与 `p8_analyze` 的解码器是同一套，不引入 ffmpeg 或额外编解码依赖。
- 每个素材最长 30 秒、文件最大 32 MB、最多 16 个；上限是渲染预算，不是音乐规则。
- 素材路径相对于**工作区根目录**，不是 `scoreFile` 所在目录。`scoreFile` 每次重读，素材也每次按文件状态重新校验；文件被替换后下一次渲染就会用新内容。
- `instrument: {"type":"sample","sample":"名字"}` 只接受 `type` 和 `sample`，不接受 `waveform`/`partials`/`stretch`/`tilt`/`unison`/`drive`/`filter`；需要滤波时用 track 级 `filter`。
- 每个音符都从选中区域的开头播放；`~slide`、`~vibrato`、`~arpfast/arpslow` 通过改变播放速度生效。`~fadein`/`~fadeout`、track/named envelope 仍然作用在采样输出的增益上。
- 切片是“同一文件 + 不同区域”的命名素材：`break_1` 和 `break_2` 可以指向同一个 WAV、写不同的 `start`/`end`，解码缓存仍只存一份。没有自动瞬态切片——切点由 score 明写，才可归因、可复现。
- `zones` 里的每项只引用同表里的普通文件素材（不能再套 `zones`）。选法是先按音高找最近的区间，再按力度找最近的层；完全落在区间外时退到最近的 zone，不会静音。鼓的 `drumSamples` 也走同一套，`~ghost`/`~flam`/`~roll` 改变力度时切换的是力度层。
- 非零 `start` 或 `reverse` 会带来 2 ms 淡入，避免从波形中间起播的爆音；不写这些字段的旧素材逐样本不变。
- 鼓映射是逐声替换：`~pitch` 改播放速度，`~tone` 加低通，`~flam`/`~roll` 与 `~ghost` 的力度/低通继续生效；`~decay`（包括 `~ghost` 的缩短衰减）会乘到采样自己的振幅上，作为 one-shot 的指数衰减。鼓素材永远按 one-shot 播放，即使素材写了 `loop: true`，也不会无限循环。
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
    { "name": "intro", "bars": 4, "bpm": 140, "mute": ["drums", "bass"], "filter": 1200 },
    { "name": "build", "bars": 4, "bpm": 155, "patterns": { "drums": "drums.B" } },
    { "name": "drop", "bars": 8, "bpm": 175, "gain": 1.05, "patterns": { "bass": "bass.B" } },
    { "name": "break", "bars": 4, "bpm": 140, "mute": ["drums"], "filter": 600 }
  ]
}
```

- `arrangement` 存在时 `mode` 默认 `song`；`bars` 由各 section 的 `bars` 相加得到，也可以显式写出，但必须一致。
- 每个 section 的长度应当是所用 pattern 长度的整数倍；否则解析器仍按旧行为截断最后一遍，并在报告里写 `pattern-misaligned` 警告。loop 模式也会对不整除 loop 的 pattern 给出同样警告。
- 一次渲染的 arrangement 总量上限是 15 分钟和 256 个 section；最终输出（包括降速后）也以 15 分钟为硬上限，超出会直接报错，而不是分配一个不可控的缓冲区。
- `patterns` 可以放在顶层，也可以放在 track 内；section 的 `patterns` 用 track 的 `name` 或 `role` 指向 pattern 名。也可以直接写内联 pattern（如 `C4:4 C4:4`，或单 token `C4`）；已定义的 pattern 名优先。
- section 字段：`bars`（必填）、`bpm`、`patterns`、`mute`、`gain`、`gains`、`filter`、`energy`、`space`、`width`、`fill`、`riser`、`tracks`、`inherit`。
- `tracks` 是段落级单轨状态：键可以是 track 的 `name` 或 `role`（同名时按 name 优先），值支持 `gain` 0-4、`pan` -1..1、`send` 0..1、`mute` true/false、`filter`（数字或 `{"from","to"}`）。`gain` 覆盖同轨的 `gains`；`mute:false` 可以把被 `mute` 列表点名的轨重新打开；`pan`/`send`/`filter` 在这一段内生效，且 `filter` 只作用于这条轨，不是整段求和后的低通。
- `inheritSections` 是整曲开关，`arrangement[].inherit` 可以逐段覆盖。继承会复制 `bpm`、`patterns`、`mute`、`gain`、`gains`、`filter`、`energy`、`space`、`width` 和 `tracks`；`fill`、`riser`、`bars`、`name` 始终只属于声明它的那一段。写 `tracks:{}` 可以清空继承来的单轨状态，写 `patterns:{}` 可以回到各轨默认 pattern。
- 不写 `inheritSections` 时旧行为不变：省略的字段仍用顶层 `bpm`、`energy:1`、`space:1`、`width:1` 等默认值，不会自动继承上一段。
- `bpm`：可选，30-300，默认继承顶层 `bpm`。变速只发生在 section 边界，小节和 step 网格不变；该段实际时长是 `bars * beatsPerBar * 60 / bpm`。loop 模式仍只有一个速度，不支持段内渐快/渐慢或任意 BPM 自动化。track 的 `delay.steps` 默认按顶层 `bpm` 计时，因此在变速段之间保持不变；要让它跟随段落网格，写 `delay.follow: "section"`。
- `riser`：1-64 小节，不能超过所在 section 的长度；在这一段末尾合成一条噪声 + 正弦上行扫频，正好结束在段落边界，用作 build/转场的上扬。它不占 track，声音由 `seed` 决定。
- `energy`：0-1 的段落宏。0 时该段增益 ×0.5，若有 `filter` 则截止频率 ×0.35；1（默认）不改变任何东西，所以旧 score 不受影响。适合写 intro/break 的“收”。单独写 `energy` 只改电平，要同时变暗还需要给该段 `filter`。
- `space`：0-2 的段落乘数，作用在轨道 `send` 总线进入混响之前；0 贴脸/干，1（默认）不变，2 是原 send 的两倍（更远、更湿）。它不改干声电平，因此不会像推音量那样改变段落响度。至少需要一条 `send > 0`（track 级或 section `tracks.<name>.send`）才有效，否则报告给出 `space-no-send` 警告。
- `width`：0-2 的段落乘数，作用在成品 side 信号上；0 折成单声道，1（默认）不变，2 更宽。它在 post 链之后、master 的 `width`/`monoBelowHz` 之前执行，所以工具级参数仍是最后一道全局裁决；`tape`/`slow` 降速后段落边界仍落在正确位置。
- `fill`：`{"bars":1,"patterns":{"drums":"drums.fill"}}`，用指定 pattern 替换该 section 最后 1-2 小节的普通 pattern；`patterns` 的键可以是 track 的 `name` 或 `role`。fill pattern 长度不整除 fill 窗口时会在报告里给出 `fill-misaligned` 警告。
- `filter` 与 `energy` 可以叠加：滤波先按 section 扫频，再乘 energy 的截止系数；`gain`/`gains` 也在 energy 之后相乘。
- `filter` 是该段的低通截止频率（Hz），作用于干声和 send 总线的输入；写成 `{"from":600,"to":12000}` 时在整个 section 内指数扫频，`from` 到 `to` 单调上升就是 riser 的滤波部分；`mute` 接受 track 的 `name` 或 `role`。
- song 模式渲染整首一次，忽略 `minutes`；需要紧结尾时用 `post: []` 并把 track `send` 设为 0。需要尾音时设置顶层 `tail`（秒），混响和 one-shot 会继续响完，最后 20 ms 淡出避免截断爆音。

### 混音与空间

- `pan` 用等功率声像，居中时左右都是 1.0，保持旧 score 的音量。
- `filter`：`cutoffHz` 100-20000；`resonance`（别名 `q`）0.05-20；`lfoHz` 0-20，`lfoDepth` 0-4 个八度。LFO 调制截止频率，适合 acid bass 和缓慢移动的 pad。
- `highpassHz` / `lowShelf` / `highShelf`：track 级 EQ，在乐器滤波之后、delay/duck 之前执行。想只把 bass 或 pad 的 150-500 Hz 挖掉、而不把整个 mix 压暗时用它；0 dB shelf 和省略字段都是逐样本无操作。
- `width` / `monoBelowHz` 是 `p8_music` 的 master 参数，在整条 `post` 链之后执行：`width` 0-2 缩放 side 信号（0 mono、1 不变、2 更宽），`monoBelowHz` 20-500 只把低频折成 mono，高频声像保留。两者默认都不执行。
- `delay`：`steps` 1-64，`feedback` 0-0.95，`mix` 0-1，`follow` 为 `"base"`（默认，按顶层 bpm）或 `"section"`（回声落在哪个段落就按哪个段落的 step 计时）。`follow: "section"` 时跨段读头连续、单调，边界处会有约 `steps` 步长的轻微变速/变调（类似磁带延迟），不会 click；loop 模式只有一个速度，两种取值等价。loop 模式会先跑 3 遍再取最后一遍，延迟尾巴在循环接缝处连续；延迟不短于一圈时按循环长度折叠，不会变成静音。song 模式中超过歌曲长度的延迟还没到达，因此是静音。
- `duck`：所有鼓轨的 kick 都会触发；每轨独立深度，启动约 5 ms、释放约 110 ms。
- `send`：轨道按 pan 把左右分别送入立体声返回；有 `group` 时进组返回（组可单独设 reverb room/damp），否则进默认返回。返回在 `post` 链之前加回干声，因此会跟随 `tape`/`lowpass` 一起被处理。
- `group`：组内轨道先合成一个子混音，再统一过组级 gain/pan/filter/EQ/delay/duck/send；一条组共享一个返回，不再需要把所有轨塞进同一条 mono send。
- `space` 和 `width` 是段落级的空间旋钮：`space` 乘在所有 send 总线/返回上（改干湿比/远近），`width` 乘在成品 side 上（改宽窄）。两者默认 1，旧 score 逐样本不变；`width` 在 master `monoBelowHz` 之前执行，低频折叠仍然有效。
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

- 步骤按数组顺序执行；`tape` / `lowpass` 作用于左右声道，`reverb` 只用输入的单声道求和驱动湿声，干声保持原来的立体声，所以插入混响不会把声像折成 mono。
- `tape` / `slow`：`speed` 0.5-1.5，降速同时降音高；多个降速步骤会串联相乘。
- `lowpass`：`cutoffHz`（或别名 `toneHz`）100-22050；`order` 1/2/4（默认 1）。1 是 6 dB/oct 一阶，2/4 是 12/24 dB/oct Butterworth。要压近 Nyquist 的毛刺用 `order: 4`；2-5 kHz 的 presence 用下面的 `highShelf` 更直接，不要把低通截止一律拉得很低。
- `highpass`：`highpassHz` 20-500，12 dB/oct 母带高通。需要让笔记本/手机小喇叭少一点嗡嗡时，放在链首用 30-40 Hz；如果整体低频仍然过多，先处理编曲里的贝斯和 kick，而不是只靠这一刀。
- `highShelf`：`hz` 20-20000（默认 3000）、`gainDb` -24..24（默认 0，0 为逐样本无操作），母带高架 EQ。想收 2-5 kHz 的 harsh/presence 时从 -3 到 -6 dB 起调；它只压拐点以上，不像把整条低通做陡那样连带牺牲 5 kHz 以上的空气感。
- `reverb`：`wet` 0-1 是干湿混合比，不是湿声增益；湿声路径本身约比干声低 5 dB，所以 `wet: 0.3` 听起来只是轻混响（湿声能量约占 6%）。`room` 0-0.98 控制房间大小，`damp` 0-1 控制高频阻尼。M2 追加可选 `predelayMs` 0-200（只延迟 send，不糊干声）、`lowCutHz` 20-1000 / `highCutHz` 1000-20000（只滤湿声，减少低频云和金属尾）、`modDepth` 0-1 / `modRateHz` 0.05-5（轻微延迟调制，削弱 comb 金属感）；都不写时与旧混响逐样本一致。
- `tilt`：`tiltDb` -12..12，700 Hz 上下的倾斜 EQ；正值更亮，负值更暗。
- `saturate`：`drive`、`mix` 0-1，tanh 软饱和，压峰并把安静段落补厚。
- `compress`：`thresholdDb`（默认 -18）、`ratio`（默认 2）、`attack` / `release`（秒）、`makeupDb`。立体声联动，检波器跟左右声道中较响的一侧。
- `loudness`：`targetLufs` -40..-5（默认 -14），按 BS.1770 积分响度整体加/减增益。通常放在 `limiter` 之前。`targetLufs` 高于 -9 会直接报错（人耳安全上限，见上）；成品即使没写这一步，只要总响度超过 -9 LUFS 也会在写文件前被拒绝。
- `limiter`：`ceilingDb`（默认 -1）、`release`（默认 0.1 s）。瞬时启动、指数恢复，保证没有样本超过 ceiling。
- `preset` 仍可用：`classic`、`dreamy`、`tape`。`speed` / `wet` / `toneHz` 是 post 的快捷覆盖；有对应步骤时改该步骤，没有时补一个。`speed` 作用于整条 tape/slow 链：第一个步骤取目标速度，后续 tape/slow 设为 1，所以链的总速度等于 `speed`。`room` / `damp` 直接写在 `reverb` 步骤里。
- `style` 填默认值：`chip`（`post: []`，无 post 处理）、`hitech`（饱和 + glue 压缩 + -14 LUFS + limiter）、`ambient`（slow 0.8 + lowpass + reverb + limiter）、`studio` / `lofi`（各自的 post 链 + 非芯片的 role 音色），以及 `soft`（clean、低阶 additive、20-80 ms attack、5.2 kHz lowpass、轻 reverb、-16 LUFS）。`style` 不改变 `mode` 和 score；和显式 `preset` 同时出现会报错，显式 `post` 仍然优先，显式 `track.instrument` 优先于 style 音色。
- `quality`：`pico`（默认，逐样本保持旧的 direct-form chip 输出）或 `clean`（saw/pulse 用 PolyBLEP 带限，FM 按 Carson 规则压 sideband index）。`soft` style 默认 `clean`；显式 `quality` 覆盖 style。clean 会改变波形，想复现旧渲染时不要传。
- `target`：可选 profile 名（`soft`、`clear`、`punchy`、`bright`、`dark`、`lofi`、`hitech`）或内联范围对象（如 `{"lowMidMax":0.22,"crestMin":12,"width":[0.2,0.5],"lufs":[-18,-12]}`）。它不是评分：报告只多出 `report target <name>: n/m checks in range`，并对每个越界维度给一条 `target` finding。`p8_analyze` 接受同一个参数。
- loop 模式下，带混响时会先跑 3 个循环再取最后一个稳态循环；取最后一圈时从缓冲区末尾回退 `loopSamples`，避免重采样取整造成补零。干声只跑 1 个循环。轨道 `send` 的 send 总线也按同样方式取稳态。

### 输出

loop 模式默认 2 分钟，WAV 由整数个循环单元重复而成，首尾可直接无缝循环。各轨求和后用共享增益把峰值压到 -1 dBFS 以下，多轨满音量也不会削波。song 模式输出整首一次。16-bit 转换前加 2 LSB 峰峰值的 TPDF 抖动（三角分布噪声），把量化误差变成约 −96 dBFS 的平坦噪声，而不是和信号相关的失真谐波；抖动序列由固定种子生成，所以同一份 score 的任何两次渲染仍然逐字节相同，流式分块写文件也与一次性编码一致。

### 渲染报告与 `p8_analyze`

每次 `p8_music` 都会在路径和参数之后返回一份报告，模型不用再盲写：

```
report peak -1.0 dBFS · true-peak -0.4 dBTP · RMS -14.1 dBFS · LUFS -12.2 · LRA 0.6 LU
report spectrum centroid 3625 Hz · sub 4% low 19% mid 35% high 24% air 19% · low-mid 31% · 2-5k 18%
report space width 0.25 · correlation 0.71 · balance +0.0 dB · onsets 25.3/s
report sections intro -18.0 dBFS w0.12 c0.99 b+0.0 dB 780Hz low-mid 28% 2-5k 12% 3.2/s · drop -10.0 dBFS w0.34 c0.82 b-1.2 dB 2400Hz low-mid 34% 2-5k 20% 6.8/s
report stems pad -7.5dBFS 3807Hz low-mid 17% pan 0.00 · drums -15.0dBFS 4490Hz low-mid 14% pan 0.00 · bass -15.0dBFS 2631Hz low-mid 19% pan 0.00
report bars 16 · 12.40 attacks/bar · 9.20 notes/bar · 16 active · 12 with drums · 5 pitch classes (entropy 1.92)
report density intro 4.00/bar d0.00 n4.00 4-4 · drop 24.00/bar d16.00 n8.00 22-26
report structure pad n48 pc6 e2.31 s0.42 l0.13 r0.75 · lead n40 pc4 e1.75 s0.60 l0.10 r0.50
report register drop pad+lead 2.1 oct
report harmony key Am 94% in key (outside D#) · 0.50 bass changes/bar · fifths 60% · steps 20% · bass intro A A F D · drop F G Am Am
report post-delta centroid -825 Hz · low-mid +8% · crest -2.5 dB · width +0.16
report finding mud: 150-500 Hz is 31% of the spectrum (mostly pad + bass)
report next: high-pass or EQ 150-500 Hz on the bass/pad, move one part up an octave, or shorten overlapping gates
report warnings: trimmed: peak safety net pulled the mix down 3.5 dB — lower track volumes to keep the authored balance
```

- peak / true-peak / RMS / LUFS / LRA：整段音频（loop 取循环本体，song 取整首）。`peak` 是 sample peak（dBFS），`true-peak` 是 4× 过采样后的 dBTP，用来发现采样点之间的过冲；它不改变峰值安全网，后者仍按 sample peak 把成品压到约 -1 dBFS。LRA 是 EBU Tech 3342 的响度范围：3 秒短时响度经绝对 -70 LUFS 和相对 -20 LU 门限后，10% 到 95% 分位的跨度。循环通常接近 0（它本来就该稳定），song 有明显强弱段时才会拉开。注意静音段会被绝对门限去掉，所以 LRA 不衡量“有没有留白”。
- 频谱：2048 样本（约 46 ms）帧的幅度谱质心与 sub/low/mid/high/air 占比，最多抽样 48 帧；不是 4 秒窗。`low-mid`（150-500 Hz）和 `2-5k` 是与五个频带重叠的诊断占比，用于找浑浊和刺耳。宽度、峰值、RMS 和 LUFS 使用全部样本。
- 空间与节奏：side/mid RMS 比（0 是单声道，1 是硬声像）、L/R 波形相关系数（-1 反相，0 不相关，1 相同）和左右 RMS 平衡（正数表示左声道更响），以及 onset 密度。宽度比值可以超过 1（混响 `wet` 很高时会出现）；判断空间时要同时看 `correlation`：`width` 大但 `correlation` 接近或低于 0，通常是混响/延迟造成的相位宽度，不是更稳定的声场。
- sections：song 模式每段的 RMS、side/mid 宽度、L/R 相关与平衡、频谱质心、low-mid / 2-5k 占比和 onset 密度。宽度和亮度是两条独立的弧线：`flat-sections` 只在电平差小于 2 dB 时提示，`flat-space` 只在宽度跨度和质心跨度同时偏小时提示（宽度 < 0.08 且质心 < 400 Hz）。
- stems：每条轨在 pan/sum 之前的 RMS、质心、low-mid、pan 和 alias 风险；按 RMS 排序，报告只列前 6 条。`stems` 只在渲染时存在，因为成品 WAV 无法反推声部。
- bars / density / structure / register：符号层面的结构读数，直接从 score 的时间线算，不消耗 FFT，也不受 post 链影响。`bars` 是总小节数、每小节平均 attack 数（和弦算 1 次 attack，鼓 `~roll`/`~flam` 按真实击数展开）、旋律音符数和全曲音级熵；`density` 是每段的 attack/鼓击/音符每小节均值与“最静–最满”区间；`structure` 最多列 4 条旋律轨：`n` 音符数、`pc` 音级数、`e` 音级熵（bit）、`s` 级进占比（1–2 半音）、`l` 跳进占比（≥5 半音）、`r` 重复小节占比（与更早某小节完全相同）；`register` 列出同一段内发声音域重叠 ≥1 个八度的轨对；`harmony` 读织体底部：每小节一个低音（该小节最低的发声音级，所以琶音读作它的最低音，跨小节的延音仍算），每小节低音变化率、四/五度与级进移动占比，以及每段的低音顺序。它不是和弦分析：不声称和弦质量、转位或功能。声明 `key` 后额外给出旋律音符落在该调自然大调/自然小调音阶内的占比和实际用到的变化音；没有 `key` 就没有这一项，因为调是声明而不是从音符里猜出来的。loop 只测写出来的那一圈，不把输出重复算进去；完整逐小节网格在 `detail: "raw"` 的 artifact 里。
- dry / post-delta：post 链之前的同口径测量，以及质心、low-mid、crest、宽度的变化。它回答“是编曲糊，还是混响/饱和把 mix 弄糊了”。
- findings：`mud`、`harsh`、`masking`、`sub-heavy`、`alias-risk`、`dynamics`、`loudness-flat`、`post-mud`、`post-harsh`、`post-dynamics`、`density-spike`、`density-flat`、`melody-static`、`melody-leapy`、`register-collision`、`key-mismatch`、`harmony-static`、`target`，每条带可选的 attribution 和 `next`。findings 是观察，不是通过/失败门槛；声明 `target` 后，`target` finding 会写出相对目标的偏差，但仍然没有总分。`loudness-flat` 是听感提示：song 的 LRA < 4 LU、段落电平差 < 6 dB 且整体响于 -16 LUFS 时触发，说明整首停在一个音量上，长听会显得吵，drop 也没有上升空间。`density-spike` 是某小节的 attack 数达到该段均值的 2 倍（至少多 4 次）；`density-flat` 是 ≥8 小节、每小节至少 4 次 attack 且相邻小节 attack 数相差不超过 1；`melody-static` 是全曲旋律加起来只用 ≤2–3 个音级（单条 bass 的两音 ostinato 不算，它是写法不是问题）；`melody-leapy` 是非 bass 轨 ≥12 个音程里级进 <30% 且跳进 ≥40%；`register-collision` 是同段两条轨的发声音域重叠 ≥2 个八度；`key-mismatch` 是声明的调与音符大面积冲突（≥32 个旋律音符里在调内不足 75%），它只说“两者不一致”，修哪边由作者决定；`harmony-static` 是 ≥8 小节的段落低音最多只动过一次。
- warnings：`dark`（2 kHz 以上太少）、`narrow`（几乎单声道；反相时改报 `phase`）、`phase`（L/R 相关低于 -0.2，单声道折叠会抵消）、`imbalanced`（左右 RMS 差超过 6 dB）、`true-peak`（dBTP 接近 0）、`sparse`（瞬态太少）、`low-heavy`（250 Hz 以下超过 70%）、`quiet` / `loud`（响于 -12 LUFS）/ `unsafe`（响于 -9 LUFS 的人耳安全上限）、`flat-sections`（段落能量差小于 2 dB）、`flat-space`（段落宽度和亮度都没有对比）、`space-no-send`（写了 `space` 但没有任何 track/section/group send）、`pattern-misaligned` / `fill-misaligned`（pattern 截断）、`trimmed`（峰值安全网下拉超过 3 dB）。`unsafe` 在渲染时是**硬错误**：成品积分响度超过 -9 LUFS 时 `p8_music` 直接拒绝写文件，而不是只给提示；`p8_analyze` 读别人的文件时仍然只报 `unsafe`，因为分析不能改变已有音频。

`p8_analyze` 对已有 WAV 做同一套测量，不需要重新渲染：

```json
{ "path": "loop.wav" }
```

它也接受 `detail: "raw"`，把完整报告写成 `loop.wav.analysis.json` 并返回路径；`p8_music` 的 `detail: "raw"` 则写 `<out>.analysis.json`（替换 `.wav`），额外包含 `stems`、`dry` 和符号结构读数 `structure`（含逐小节 `grid`、逐轨读数、逐段密度、音区重叠和 `harmony` 低音/调性读数）。两个路径不冲突，artifact 不占模型上下文，需要时再读。`p8_analyze` 只接受 16-bit PCM WAV（本插件自己的输出），其它格式会给出明确错误。

`p8_analyze` 还可以用 `sections` 给已有 WAV 分段：每段写 `name`、`startSeconds`，`durationSeconds` 可省略（到下一段开头；最后一段到 `contentSeconds` 或文件末尾）。时间按**输出文件**计，`tape`/`slow` 之后已经缩放；要排除歌曲尾音就同时写 `contentSeconds`。这样不用重新渲染也能得到每段 RMS、宽度、相关性和平衡：

```json
{"path":"song.wav","sections":[{"name":"intro","startSeconds":0},{"name":"drop","startSeconds":8}]}
```

### 音色探针 `p8_probe`

成品报告只能说明“整首歌听起来怎样”，不能说明某个乐器的音色参数应该往哪调。`p8_probe` 把一条旋律轨变成一个固定音符的干声：固定音高、力度、gate，不跑 post、轨道 EQ/滤波/延迟/duck/send，也不写 WAV。它返回的是源级测量和参数敏感度：

```json
{"scoreFile":"song.json","track":"lead","note":"A4","volume":5,"seconds":1.5,"sensitivity":true}
```

```
Probe lead (fm) A4 440.00 Hz · vol 5 · 1.50 s · pico · filter off
envelope attack 4 ms · decay <1 ms · sustain 1.00 · release 8 ms
source slope -1.8 dB/oct · centroid 1.7 kHz · rolloff85 3.1 kHz · attack 2 ms · decay n/a · HF decay 163 ms · 26.6 dB/s · high 30% · air 0%
fm ratio 3.00 · index 2.40 · indexDecay 600 ms · sidebands 5 · carrier 7% · alias risk no
centroid trajectory early 1.5 kHz -> late 494 Hz
sensitivity envelope.attack 0.00->0.05: attack +42.4 ms · fm.index 2.40->4.40: slope +1.1 dB/oct, centroid +1407.0 Hz, rolloff85 +1324.3 Hz, high +53% · fm.indexDecay 0.60->1.20: HF decay +183.7 ms, HF decay rate -14.1 dB/s
next: if brighter: raise fm.index or filter cutoff; longer HF tail: raise indexDecay; different sideband spacing: change ratio; attack/release: envelope
```

- **频谱斜率**：周期性的 chip/additive 用谐波回归（dB/oct）；FM/采样/噪声等密集或非谐频谱用 1/3 倍频程带功率回归。纯正弦或谐波太少时返回 `n/a`，不硬凑一个数。
- **奇偶谐波比**：只在稳定谐波列存在时报告；比值只看 n>=2 的上方谐波，基频不计入，避免“所有音都偏奇次”的假象。FM 用边带（carrier share、显著边带数、最高边带、Carson/Nyquist 混叠估计），采样素材自己拥有频谱，chip noise/phaser 和 additive `stretch` 也会明确标记不适用。
- **攻击/衰减**：攻击是 10%-90% 上升时间，衰减是峰值到 -20 dB；同时回显作者写的 ADSR，方便区分“参数写了什么”和“实际听到什么”。
- **高频衰减**：2-8 kHz 能量的时间常数和 dB/s。`fm.indexDecay`、滤波包络、逐谐波衰减改变的是这条随时间变化的曲线，不是整段平均斜率。
- **敏感度**：用同一个音符分别改 `envelope.attack`、`additive.tilt`、`fm.index`、`fm.indexDecay` 或 `filter.cutoffHz`，报告指标的实际变化量。没有参数敏感度的指标不可操作；这比往成品报告里塞四个全局数字更能让模型自己调包络和 FM。

如果成品用了 `style`，探针也要传同一个 `style`，这样 role 默认音色和 `quality` 才和成品一致；显式 `track.instrument` 仍然优先。`bypassFilter: true` 会移除 instrument 自己的滤波，测“源”本身；默认保留，因为那才是渲染时听到的音色。`detail: "raw"` 把完整读数写到 `p8-probe.json`（可用 `out` 改路径），不占模型上下文。探针不是评分，也不替代 `p8_music` 的成品报告：它测的是单音源，成品仍要看混音、空间和响度。

`target` 和 `assert` 是两种不同的判断。`target` 只给偏差，不改变调用结果；`assert` 是硬检查，任一范围不满足时工具直接报错（`p8_music` 在写 WAV 之前失败，`p8_analyze` 在返回报告之前失败），失败信息会列出具体维度：

```json
{"assert":{"peakMaxDb":-1,"truePeakMaxDb":-0.5,"lufs":[-16,-12],"width":[0.2,0.6],"correlation":[0.2,1],"balanceMaxDb":3}}
```

可用的 `assert` 字段：`peakMaxDb`、`truePeakMaxDb`、`rmsDb`、`lufs`、`lra`、`crest`、`width`、`correlation`、`balanceMaxDb`、`sectionLevelSpreadDb`、`sectionRmsDb`。`target` 则额外支持 `lowMidMax`、`harshMax`、`centroidHz`，并新增 `truePeakMax`、`correlation`、`balanceMax`；两者都仍然没有总分。

## 导出 MusicXML

`p8_export` 把 score 写成未压缩的 MusicXML 4.0 partwise XML（`.musicxml`），不渲染音频，也不接受 `post`/`preset`/`style`/`minutes`：

```json
{
  "scoreFile": "examples/m1-16bar.json",
  "out": "m1.musicxml"
}
```

- 每条 track 是一个 `<part>`；loop 只写一圈，song 写绝对时间线，所以段落、静音段和 pattern 填充与 WAV 的排程一致。
- `stepsPerBeat` 写成 `<divisions>`，`beatsPerBar` 写成 `<time>` 的拍数（beat-type 仍为 4，和 score 的网格语义一致）；和弦用 `<chord/>`，跨小节音符拆成 tied segments，空槽补 rest。
- 段落名写成 `<rehearsal>`，`bpm` 写成 `<sound tempo>`；变速只出现在第一个 part，避免导入器重复显示速度标记。
- 鼓轨写成 `<unpitched>` 打击乐，使用 channel 10 和 GM drum 音高；镲/踩镲/拍手用 `x` 符头。
- 声明的 `key` 写成 `<fifths>`/`<mode>`；调律保留为小数 `<alter>`（A4=442 会写成 +0.0785 半音），不会被静默压回十二平均律。
- 输出是纯 XML 文件，不是 zip 压缩的 `.mxl`；`out` 必须以 `.musicxml` 结尾，省略时用 `pico8-music.musicxml`。记谱只表达音高/时值/小节/鼓声，不表达 slide/vibrato、滤波、声像、混响等渲染参数。

## 开发

```bash
bun --version      # >= 1.2，直接运行 .ts
bun test           # 运行全部测试
bun run typecheck  # tsc --noEmit
bun run check      # 边界检查 + 类型检查 + 测试
```

工具链只有 bun 一条：`bun.lock` 是唯一的锁文件（不再有 `package-lock.json`），`bun install` 后 `src/` 的 TS 直接运行，不需要编译步骤。`bun run build` 才调 `tsc` 生成 `dist/`，用于不运行 TS 的宿主；构建启用了 TypeScript 的 `rewriteRelativeImportExtensions`，所以源码里的 `.ts` 相对导入会变成 `.js`，不需要手改。`package.json` 仍是 `private: true`；要发布到 npm 必须先去掉 `private`。DSH 0.2 读取 `package.json.dsh`（`manifestVersion: 1` + `bundle.patch`），不再有单独的 `dsh-plugin.json`。

## 已知限制

- 音源有四类：8 个内置 chip 波形、带限 additive 谐波（静态波表或逐 partial 合成）、FM（经典两算子或 1-3 个固定路由调制器），以及工作区里的 16-bit PCM WAV 素材。采样支持区域切片、反向、循环点、按键/力度分层的 zone 映射，仍只做线性插值变速；没有自动瞬态切片，也没有独立的 wavetable 文件类型（短素材 + `loop: true` 就是波表）。物理建模仍不做。
- PICO-8 在这里是音色与编曲风格，不是硬件复刻：单轨和弦加 legato 可以同时超过 4 个声部，输出是 44.1 kHz 立体声，而不是 22050 Hz / 4 单声部通道。没有严格 `pico` 模式。
- 效果是音乐语义的近似，不是 PICO-8 sfx 状态机的逐样本复刻。
- 鼓默认是合成瞬态；`drumSamples` 可以按声替换成 WAV，`~ghost` 的力度/低通、`~flam`/`~roll` 与 per-hit `~pitch`/`~tone` 仍生效，但采样鼓的 `~decay`（含 ghost 的缩短衰减）会被忽略，也没有逐 hit 滤波包络。
- M2 和声/发音法已做：显式与命名和弦、斜杠低音、gate、swing、命名 per-note 包络、参数化 slide/vibrato、seed。仍不做 `key`/`scale` 度数记谱与 voice leading：命名和弦已覆盖大部分和声写法，voice leading 需要跨段和声状态且验收主观。
- M3 已做：per-track filter（带 LFO/共振）、段落滤波扫频、pan、send、duck（kick 触发）、step 计时 delay。M8 追加了独立的段落 `riser`、`tail` 与 `humanize`；分组/总线与立体声 send 已补齐：每组有独立返回和组级 gain/pan/filter/EQ/delay/duck，轨道 send 保留 pan。仍不做任意 sidechain 源和 impact/sub-drop 采样 FX。
- M4 已做：渲染报告（sample/true peak、RMS、LUFS/LRA、频谱、宽度/相关/平衡、onset、分段、警告）、`p8_analyze`（可用 `sections` 给已有 WAV 分段）、`assert` 硬检查、`tilt`/`saturate`/`compress`/`loudness`/`limiter` 五个基础 master 步骤，以及可选的 `lowpass.order`（12/24 dB/oct）和 `highShelf` 母带 EQ。
- 结构报告是**符号分析**，不是音频热力图：`bars`/`density`/`structure`/`register` 从 score 的时间线精确计算（loop 只算写出来的那一圈），所以能归因到小节、轨道和段落，也不改变任何 DSP。`harmony` 同样只读谱面：低音是“该小节最低的发声音级”，不是和弦符号，也不是从成品反推出来的调。它看不到混响把音头糊掉、限幅压平瞬态这类只有音频才知道的事——那仍然看 `onsets`、crest 和 `stems`。也不做逐帧频谱矩阵或图片输出：对模型来说那是一堆无法对应到旋钮的数字，逐小节网格只放在 `detail: "raw"` 的 JSON 里。
- 空间与能量弧线 P0 已做（见 `docs/space-energy-plan.md`）：段落 `space`（send 乘数）、段落 `width`（side 乘数）、每段 level/width/correlation/balance/centroid/onset 读数，以及 `flat-space` / `space-no-send` 警告。报告已补 L/R 相关性和左右平衡；仍不做任意自动化曲线和逐段混响参数。
- 分析路线图 M2 已做：`quality: "clean"` 带限 chip/FM、track 级 high-pass/低/高 shelf、master `width`/`monoBelowHz`、reverb predelay/low-cut/high-cut/轻调制、`target` profiles 与 `soft` style。全部 opt-in；不传新字段时旧渲染逐样本不变。仍不做自动混音、自动母带或单一评分。
- 可复用演奏法与音色预设已做：顶层 `articulations` 把 gate/volume/envelope/effect 组合命名后用 `~名字` 引用，顶层 `presets` 把 instrument/envelope/默认 articulation/轨道音色字段组合成 track 可引用的音色；两者都是 score 内数据，track 显式字段优先。仍不做 per-instrument 独立调音、per-note 滤波、跨 score 的声库文件，也不把 `post` 链写进 preset。
- M6 已做：命名/内联 `instruments`（chip / additive / FM）、unison 失谐、drive、逐音滤波包络、鼓的 per-hit pitch/decay/tone、`studio`/`lofi` 两个换音色的 style。采样素材（`samples` / `drumSamples`）已支持 16-bit PCM WAV、区域/循环/反向与分键分层；FM 已支持固定路由的多算子。仍不做任意 FM 算子矩阵与反馈、自动切片、per-note pan。
- additive 扩展已做：`stretch` 非谐、`tilt` 频谱倾斜、逐谐波衰减；静态路径逐样本兼容。FM 多算子已做：`operators` 是固定路由的树（每条边指向更低编号），覆盖串联/并联与链式调制。仍不做公式/表达式音源、任意算子矩阵、反馈和独立波表文件。
- 力度到音色已做：`chip`/`additive`/`fm` 的 `velocity: {cutoffOctaves, drive, indexScale}` 让 `@力度` 打开滤波 cutoff、增加 drive，并在 FM 上收窄 index；不写或全 0 时逐样本不变，`sample` 乐器不接受这个字段。暂不把力度映射到 envelope decay，避免在没有明确听感目标时扩大语义。
- 调律已做：顶层 `tuning` 的 `a4` 400-480 Hz、七种内置律制和逐音 `cents`；律制以 A 为锚点，所以换律制不会移动 A4，逐音 `cents` 还能在此基础上微调任意键。采样音源靠变速跟随目标频率，所以逐键微调也生效；zone 可以按音区/力度换素材且各自带 `root`，但没有 per-zone 独立调律，`root` 仍按素材自身的 440 Hz 十二平均律解释。
- 轨数上限是 32，命名分组上限也是 32，不是音乐规则：每条轨都要一整段 buffer，每个使用中的组还要一条子混音 buffer 和一条立体声 send buffer，所以长歌 + 很多组会明显变慢。需要更多层次时优先增加 track 或把同处理的轨道放进一个 group。
- `humanize` 只改时序和力度，不做 probability/ratchet；`tuplet` 仍不做：三连音需要分数 step 网格，会同时影响 parser、swing、段落对齐和循环接缝，收益低于成本。
- 段落变速已做：`arrangement[].bpm` 在 section 边界切换速度，默认继承顶层 `bpm`；loop 模式仍是单一 BPM。暂不做段内渐快/渐慢、任意 BPM 自动化。`delay.steps` 默认仍按顶层 bpm 计时；写 `delay.follow: "section"` 可以按段落网格重算回声时间，代价是边界处会有最多约 `steps` 步长的变速/变调窗口。
- song 模式的 `send` 混响和 `post` 混响尾音默认会在歌曲结束时截断；设置顶层 `tail` 可以留出收尾时间，或用 `send: 0` + `post: []` 做紧结尾。
- `limiter` 按样本峰值工作，不做 4× 过采样，所以它是 sample-peak 而不是严格的 true-peak limiter；44.1 kHz 的 WAV 上两者差距通常小于 0.5 dB。
- 循环长为整数采样；`speed` 不是整数比时会有一点点有效速度偏差（< 0.01%）。
- 渲染在工具调用内同步完成；loop 默认 2 分钟在本机约 3 秒，机器相关，更长请先控制 `minutes`。合成、混音和分块写文件都会检查 abort，但单个 DSP 步骤（如整段 reverb）仍可能运行数秒才返回。
- `out` / `p8_analyze` 的 `path` 都以宿主会话的工作区为根（DSH 取 `exec.agent.session.header.cwd`，Pi 取 `ctx.cwd`），而不是插件进程的 `process.cwd()`；只有宿主不给会话目录时才回退到进程目录。路径必须留在该工作区内；`p8_music` 的输出必须是 `.wav`，`p8_export` 的输出必须是 `.musicxml`。这条边界由插件服务层自己执行，不依赖宿主是否检查 manifest。
- 15 分钟是最终输出（含 `tape` 降速后的长度）的硬上限。`executeRender` 不再一次性编码整段 WAV，而是按 16384 帧分块写文件；渲染阶段仍会同时持有循环/歌曲样本和中间后处理缓冲，内存随长度线性增长。
- `p8_analyze` 只接受 16-bit PCM；报告同时给 sample peak 和 4× 过采样 true peak，但 limiter 和峰值安全网仍按 sample peak 工作，所以 `true-peak` 可能比 `peak` 高约 0.5-1 dB。
- `p8_export` 是符号记谱导出，不是音频格式：每条 track 只有一个 MusicXML voice，不写力度记号、slur、歌词、slide/vibrato 或 mix/post 参数；拍号固定用 beat-type 4 跟随 score 的网格，鼓用固定的谱面位置和 channel 10。它只输出未压缩 `.musicxml`，不生成 zip 的 `.mxl`。
