# 设计边界与风险

这个插件刻意不做什么、模块之间怎么分工、以及在哪些地方已经明确接受了取舍。

**当前/目标的区分：** 已实现的曲式只有 `loop` 与 `song`，不存在 `pico` / `studio` 能力模式——`pico` 是 `quality` 的取值，`studio` 是 `style` 的取值。三阶段迁移仍未全部落地，`cue` 曲式与 stems 分轨导出仍是提案，边界分别见下面的「兼容边界」和 [`forms-and-exports.md`](./forms-and-exports.md)；mix/master（tilt/highShelf、饱和、压缩、响度目标、limiter）已在 M4 落地，已实现项与已知限制以 [`../README.md`](../README.md) 的「已知限制」和 [`expressiveness-review.md`](./expressiveness-review.md) 的里程碑一节为准。

## 产品边界

- **不做成 DAW。** 目标是给模型一组可组合的音乐原语，不是完整宿主。每个新参数都要有默认值和风格预设，否则模型会写出「参数很多但音乐很乱」的 JSON。
- **曲式、默认值、输出形态是三件事。** `mode` 只描述时间线（`loop` 单圈无缝重复 / `song` 有编排的一遍），不自带音色或能力上限；`style` 填默认值，`quality` 选渲染精度，`preset` 只管 post 链。候选 `cue` 属于曲式，stems 属于导出目标，都不能再被包装成第四种「模式」。详见 [`forms-and-exports.md`](./forms-and-exports.md)。
- **PICO-8 音色是默认值，不是天花板，但不做硬件复刻。** 保留 4 轨、8 波形的默认建议；`instrument` 可以换成带限 additive、两算子或固定路由多算子 FM、以及工作区采样音源，`studio`/`lofi` style 按 role 填非芯片音色。单轨和弦与 legato 可以超过 PICO-8 的 4 个单声部通道，轨数上限 32 只是渲染预算，不是音乐规则。没有严格 `pico` 模式。
- **不靠增加波形编号扩音色。** 再加第 9 个芯片波形不会解决音色单一的问题；脱离芯片听感靠的是 voice 类型（additive/FM、unison、滤波包络、drive），不是更多 `waveform` 数字。波形形状由 `additive.partials`（振幅 + 相位 + 可选衰减）、`stretch` 和 `tilt` 描述，模型自己设计；旧的 8 波形路径必须逐样本不变。**不做公式/表达式音源**：周期公式与 `partials` 重叠，非周期音色用 `samples` 更好，DSL 保持为数值参数，避免把分数变成程序。
- **「更多参数」不等于「更好听」。** 优先做鼓、段落、gate、和弦/动机、滤波这几组高杠杆项；混音和 master 放在后面。M4 的 master 步骤和 style 都只补默认值，模型仍应先写编排。

## 模块边界

- `score` 只负责解析和归一化，不碰 DSP（详见 [`features/score.md`](./features/score.md)）；绝对时间线展开 `timelineOf` 也在这里，因为它是符号排程。
- `structure` 只从 Score 时间线算符号结构（每小节密度、旋律运动/重复、音区重叠），不碰音频、不写报告文案（详见 [`features/structure.md`](./features/structure.md)）。
- `render` 负责合成、混音、后处理、音频测量，以及后处理链的显式契约（详见 [`features/render.md`](./features/render.md)）；findings 的措辞和阈值都留在这里。
- `app` 只负责工具注册、文件写入、报告。
- **局部试听不是新曲式。** `sections` 只选 song 的连续段落，并在 `score` 层用 `excerptOf` 重基到 0；`solo`/`mute` 只在 `render` 层过滤可听轨，不改 score。excerpt 独立过峰值安全网和母带，因此不能拿它的 LUFS 与整首比；被 mute 的 kick 也不再触发 duck。两者都是试听工具，不是导出形态。
- **输出形态不是曲式。** 若采纳 `cue`，`score` 只加解析与时间线，`render` 只加「一遍 + tail」的分支；stems 的目录、命名、manifest 与临时文件清理归 `app`，`render` 只提供每轨/每组/每条 send 的音频和元数据；组级 `saturate`/`compress` 是组子混音的一次性处理，不是另一条 post 链。详见 [`forms-and-exports.md`](./forms-and-exports.md)。
- **文档分层**：`.agents/skills/pico8-songwriter/SKILL.md` 是作曲指南（选型、小节网格、轨道布局、段落、混音决策、跟报告改曲）；`src/features/score/help.ts` 是线格式（字段、token 语法、范围、默认值、报错）。两者交叉引用，不复制正文；新增字段时先改 `parse.ts`，再改 `help.ts`，只有在“怎么用这个参数写出好听的曲子”发生变化时才动技能文档。

## 兼容边界

- 旧 score 的行为必须可复现；新增字段默认关闭。
- 迁移分三阶段（第 1、2 步已落地，第 3 步仍待做；默认 `classic` 仍带隐式 slow+reverb）：
  1. 新增 `mode`、`post`、`sections`、`role`、`drums`，但默认行为不变。
  2. 把 `preset` 标记为 post 快捷方式，新增 `style`（`chip` / `hitech` / `ambient` / `studio` / `lofi` / `soft`，只填默认值，不改变 `mode`）。
  3. 移除 `renderLoop` 里的隐式 slow+reverb，改为显式 post。
- 迁移期保留旧 `preset` 行为，避免破坏现有调用。
- 若实现，`cue` 与 stems 都必须是 opt-in：未请求时 `loop` / `song` 的 WAV 逐字节不变。

## 资源边界

- **Token 预算**：pattern bank + role 默认值 + 紧凑 token 是关键；不要让模型为每个音写对象。
- **渲染时间**：复音、滤波、sidechain、轨道数都会增加 CPU。解析器把整首限制在 15 分钟、256 个 section、32 条轨；渲染循环检查 abort，但单个同步 DSP 步骤不能中途抢占。按 block 处理，避免逐样本分配。分轨导出必须逐轨写盘，不能保留 32 条整段 buffer；loop 的 stems 只写一圈，重复由 consumer 负责。
- **素材边界**：采样素材是工作区里的 16-bit PCM WAV，最多 16 个、每个 30 秒/32 MB。app 层负责路径越界检查、解码和进程内 `path+size+mtime` 缓存；score 只保存引用，render 只接收已解码的 mono PCM。素材不是持久化缓存层：文件本身和 score 才是持久化对象。
