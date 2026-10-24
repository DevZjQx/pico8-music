# 空间感与能量起伏计划

这份计划补的是编曲层面最容易“听起来平”的两个维度：**段落之间的能量弧线**，以及**声音在远近、宽窄、疏密上的移动**。它延续 [`analysis-roadmap.md`](./analysis-roadmap.md) 的原则：报告先给测量，再给可执行的下一步，不给总分；新能力默认关闭，旧 score 逐样本不变；插件只提供可组合的原语，不自动混音。

状态：**P0 已实施**（`space` / `width` / 段落四维读数 / `flat-space` / `space-no-send`）；P1 待排期；P2 的字段文档已随 P0 同步，空间弧线已并入技能文档现有的段落表。

## 实施前的判断（P0 之前）

- 能量起伏**能写**：段落已有 `gain` / `gains` / `mute` / `filter`（含 from→to）/ `energy` / `riser` / `bpm` / `fill`，但 `energy` 只缩增益，只有同时写了 `filter` 才变暗；报告每段只有 RMS，`flat-sections` 也只看 RMS。
- 空间感**不可变**：`pan` / `send` 是轨道常量，`width` / `monoBelowHz` 是整首一次的 master 参数，混响参数也是全局的。因此“铺垫远、高潮近”只能用亮度伪装，干湿比在段落之间从未改变；报告里的宽度也只有一个全局值。
- 转场元素本身有缺陷：`riser` 左右写同一个采样值（双单声道），且被 `energy` 反向衰减。

## 设计原则

1. **测量不是评分。** 新增的段落读数只描述事实；`flat-space` 是观察，不是通过条件。
2. **默认中性。** `space` / `width` 默认 1；缺省时不改变任何采样，golden hash 必须保持不变。
3. **只影响 song 模式。** 段落字段只在 `arrangement` 存在时生效，loop 模式没有段落，行为不变。
4. **不做隐式联动。** 不因为 `energy` 低就自动加混响，也不因为进入 drop 就自动变宽。“铺垫湿、drop 干”是风格选择，不是通则。
5. **旋钮要能被报告验证。** 每加一个空间参数，报告里必须有对应的段落读数，否则模型只能盲写。

## P0：可测量、可编写的空间弧线（已实施）

### P0-1 段落四维读数

`SectionReading` 从 `name` + `rmsDb` 扩展为：

| 字段 | 含义 |
| --- | --- |
| `rmsDb` | 该段电平 |
| `width` | 该段 side/mid RMS 比（0 为单声道，与全局宽度同口径） |
| `centroidHz` | 该段频谱质心（亮度/远近的代理） |
| `onsetPerSecond` | 该段瞬态密度（疏密的代理） |

实现要点：

- `sectionEnergies` 改名为 `sectionReadings`，电平与 mid/side 在一次遍历里完成；质心复用 `readSpectrum`，但每段帧数上限降到 8 帧（`SECTION_SPECTRUM_FRAMES`），避免 256 个段落把报告变成第二次渲染。
- 摘要行扩展为 `report sections intro -18.0 dBFS w0.12 780Hz 3.2/s · drop ...`；raw artifact 自动带完整字段。
- 新增警告 `flat-space`：段落数 ≥ 2，且 **width 跨度 < 0.08 同时 centroid 跨度 < 400 Hz** 时提示。只平一项不算平：亮度和宽度任一条弧线在动，空间就有对比。
- 电平对比仍由 `flat-sections`（RMS 差 < 2 dB）负责，两者独立。

### P0-2 段落 `space`：移动干湿比

- 字段：`space`，0–2，默认 1，song 专有。
- 语义：该段 track `send` 总线进入混响前的**乘数**。`0` 贴脸/干，`1` 不变，`2` 比原 send 多一倍（更远、更湿）。它只乘 send 总线，不动干声电平，所以不会像推音量那样改变段落响度。
- 实现：`applySectionSend` 在 `applySectionFilter` 之后按段缩放 `sendBus`，尾部沿用最后一段的系数；段落边界与 `filter` 使用同一套绝对时间。
- 前提：只有至少一条轨道 `send > 0` 时才有总线。解析器在“有 `space` 但没有任何 send”时给出 `space-no-send` 警告，避免静默无效。
- 不做的事：不改混响 decay/room（共享总线改衰减会波及全曲），也不自动和 `energy` 联动。

### P0-3 段落 `width`：让画面开合

- 字段：`width`，0–2，默认 1，song 专有。
- 语义：该段成品 side 信号的乘数。`0` 折成单声道，`1` 不变，`2` 更宽。
- 实现：`applySectionWidth` 在 post 链之后、master `monoBelowHz` / `width` 之前执行，因此工具级参数仍是最后一道全局裁决；段落秒数按 `chainSpeed` 换算，`tape` / `slow` 降速后弧线仍落在正确位置。
- 低频保护：段落宽度在 master `monoBelowHz` 之前执行，所以低频折叠仍能在最后把低频拉回中央；若把段落宽度放到 `monoBelowHz` 之后，会重新把低频拉开。
- 与 P0-1 配合：写 `width` 之后，`report sections` 的 `w` 值必须随之变化，否则就是边界算错。

### P0 验收

- `space` / `width` 缺省或显式写成 1 时，song 渲染与改动前逐样本一致；loop 模式完全不受影响。
- golden hash（dry / classic / hitech）不变。
- 段落读数在静音段、变速段、带 `tail` 的结尾都不越界；`width ≥ 0`，`centroidHz ≥ 0`，`onsetPerSecond ≥ 0`。
- 测试覆盖：
  - 解析默认值、2.5 等越界值被拒；
  - `space` 2 vs 0.2 时，前段 `width` 明显更大；
  - `width` 0.3 vs 1.7 时，后段宽度约为前段的两倍以上；
  - `tape` 0.8 下宽度弧线仍落在正确段落；
  - 相同材料的两个段落触发 `flat-space`，宽度/亮度有对比时不触发；
  - 有 `space` 无 `send` 时出现 `space-no-send`；
  - `report sections` 文本包含 `w` 与 `Hz`。

## P1：让转场本身有宽度和方向

### P1-1 `riser` 去相关，并不再被低能量压小

现状：`addSectionRisers` 把同一个噪声值同时写进左右声道，且振幅乘 `0.5 + 0.5 * energy`。结果是最重要的转场瞬间零宽度，而且越克制的 build 越听不到上扬。

计划：

- 左右各用一个独立 seed 的噪声源，或用 3–7 ms 的右声道延迟去相关；保留正弦扫频在中央，作为方向锚点。
- 取消 `energy` 对 riser 的衰减，或改为只跟“段落是否有 riser”相关；riser 的强弱由长度和所在段落决定。
- `space` 是否作用于 riser：暂不，riser 是干声事件；若以后要给 riser 加 send，单独开一个 send 比例，不要复用轨道 send。

验收：riser 段落的左右相关性明显低于单声道版本；低 `energy` 的 build 不再自动变小声；旧 score 不含 `riser` 时逐样本不变。

### P1-2 `energy` 支持段内渐变

现状：`energy` 是解析期乘进每个事件的常数，只有 `filter` 支持 from→to。真正“渐进”的 build 只有亮度在动，密度和电平是硬切。

计划：

- 接受 `{"from":0.35,"to":1}` 形式，与 `filter` 同一套语义：线性/指数选择沿用现有约定，只在段内插值，不跨段。
- 电平渐变在渲染期按段内进度乘到干声与 send；不要改解析期的 timeline 事件，否则 `gain` 会失去归一化含义。
- 与 `filter` 的 energy 系数叠加顺序写进文档：先算段内 energy 曲线，再乘到 filter 截止。

验收：from=to 与现有常数行为逐样本一致；渐变段落的段落读数呈单调变化；`tape` / `slow` 下时间轴仍正确。

## P2：文档与创作指南

### P2-1 把空间弧线写进技能文档

状态：已随 P0 完成。数值写在现有 Arrangement 表的每个段落行里，并在 Mix and space 表补了 `space` / `width` 两行，没有另起一张重复的表。

| 段落 | 典型空间动作 |
| --- | --- |
| intro | `space` 1.3–1.8、`width` 0.6–0.9、少轨；用 `filter` 压高频 |
| build | `space` 逐步回 1；加入短延迟/更清晰的打击乐；宽度回到 1 |
| drop | `space` 0.5–0.8、`width` 1.1–1.4；低频保持 `monoBelowHz` |
| break | `space` 回 1.2+，撤鼓和 bass，留混响/延迟尾 |
| outro | `space` 再拉远、`width` 收窄，保留 `tail` |

同时明确三条容易写错的语义：

- `energy` 单独只改音量；要变暗必须同时给 `filter`。
- `space` 只缩放 track send，没有 `send` 就没有效果。
- `width` 是段落乘数，工具参数 `width` 仍在其后全局生效。

### P2-2 同步线格式与 README

状态：已随 P0 完成（`help.ts`、`README.md`、`docs/features/score.md`、`render.md`、`evaluation.md`）。

- `help.ts`：Arrangement 表新增 `space` / `width`，报告说明加入段落读数与 `flat-space`。
- `README.md`：段落字段列表、混音与空间小节、报告示例与警告列表。
- `docs/features/score.md` / `render.md` / `evaluation.md`：把“段落 RMS”改为“段落电平/宽度/质心/瞬态”，并写明 `space` 与 `width` 的执行顺序。
- 不在 `help.ts` 和技能文档之间复制正文：字段与范围只留在 `help.ts`，弧线建议只留在技能文档。

验收：`bun run check` 通过；`p8_help` 的 Arrangement 表包含两个新字段；README 的报告示例与新格式一致。

## 非目标

- 不做 DAW 式自动化曲线、任意时间点的包络编辑。
- 不自动决定“drop 应该更干”：这仍是风格选择。
- 不新增总分；`flat-space` 只是与 `flat-sections` 并列的观察。
- 暂时不引入 L/R 相关性数值。段落 `width` 仍可能被高湿混响推到 > 1，解释规则与全局宽度相同（见 `docs/evaluation.md`）。

## 风险与取舍

- **单声道兼容**：段落 `width` > 1 会放大侧信号，宽合成器可能相位抵消；文档要求用 `monoBelowHz` 保护低频，并保留全局 `width` 作为最后收口。
- **阈值误报**：`flat-space` 的 0.08 / 400 Hz 是起点，ambient 这类本来就不追求宽度对比的曲子会被提示；它是警告不是错误，后续用 A/B 渲染校准。
- **响度**：`space` > 1 会抬高 send 返回，峰值安全网和 limiter 仍会兜底，但极端值应靠听感而不是靠限幅。
- **性能**：段落读数增加每段最多 8 帧 FFT 与一次切段遍历；256 段的最坏情况仍远小于一次完整渲染。
