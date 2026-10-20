# 设计边界与风险

这个插件刻意不做什么、模块之间怎么分工、以及在哪些地方已经明确接受了取舍。

**当前/目标的区分：** `pico` 与 `studio` 模式、三阶段迁移仍属于既定方向，尚未全部落地；mix/master（tilt、饱和、压缩、响度目标、limiter）已在 M4 落地，已实现项与已知限制以 [`../README.md`](../README.md) 的「已知限制」和 [`expressiveness-review.md`](./expressiveness-review.md) 的里程碑一节为准。

## 产品边界

- **不做成 DAW。** 目标是给模型一组可组合的音乐原语，不是完整宿主。每个新参数都要有默认值和风格预设，否则模型会写出「参数很多但音乐很乱」的 JSON。
- **PICO-8 音色优先于通用引擎，但不做硬件复刻。** 保留 4 轨、8 波形、无采样的风格约束；单轨和弦与 legato 可以超过 PICO-8 的 4 个单声部通道，输出仍是 44.1 kHz 立体声。目前没有严格 `pico` 模式，也没有 `studio` 模式。
- **不优先扩波形和效果数量。** 当前 8 个波形已经够用；再加 8 个波形不会解决没有鼓、没有段落、没有和声的问题。先做结构，再扩音色。
- **「更多参数」不等于「更好听」。** 优先做鼓、段落、gate、和弦/动机、滤波这几组高杠杆项；混音和 master 放在后面。M4 的 master 步骤和 style 都只补默认值，模型仍应先写编排。

## 模块边界

- `score` 只负责解析和归一化，不碰 DSP（详见 [`features/score.md`](./features/score.md)）。
- `render` 负责合成、混音、后处理，以及后处理链的显式契约（详见 [`features/render.md`](./features/render.md)）。
- `app` 只负责工具注册、文件写入、报告。

## 兼容边界

- 旧 score 的行为必须可复现；新增字段默认关闭。
- 迁移分三阶段：
  1. 新增 `mode`、`post`、`sections`、`role`、`drums`，但默认行为不变。
  2. 把 `preset` 标记为 post 快捷方式，新增 `style`（`chip` / `hitech` / `ambient`，只填默认值，不改变 `mode`）。
  3. 移除 `renderLoop` 里的隐式 slow+reverb，改为显式 post。
- 迁移期保留旧 `preset` 行为，避免破坏现有调用。

## 资源边界

- **Token 预算**：pattern bank + role 默认值 + 紧凑 token 是关键；不要让模型为每个音写对象。
- **渲染时间**：复音、滤波、sidechain 都会增加 CPU。解析器把整首限制在 15 分钟、256 个 section；渲染循环检查 abort，但单个同步 DSP 步骤不能中途抢占。按 block 处理，避免逐样本分配。
- **素材版权**：不要把外部采样包打进插件；鼓和 FX 用合成，或者让用户自备采样。外部参考素材只作为设计参照，不入库、不打包。
