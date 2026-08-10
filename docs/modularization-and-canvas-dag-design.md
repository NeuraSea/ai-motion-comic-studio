# 模块化拆分与 Canvas + DAG 设计文档

> 状态：设计已确认（2026-08），待在新 worktree 中实施
> 背景：从「漫剧工坊」单产品形态，演进为支持真人数字人（脱口秀场景 Demo）等多业务的通用 AIGC 生产工作台
> 关联文档：[`plan.md`](../plan.md)、[`README.md`](../README.md)

---

## 1. 背景与目标

### 1.1 直接动因

需要制作一个 Demo 视频：**脱口秀场景真人数字人**。国内一线脱口秀演员提供照片 + 授权素材，平台方产出质量可控的数字人视频。技术栈：

- Ark Agent Plan 的 **Seedance 2.5 API**（视频生成，首帧驱动）
- Codex Tools 的 **gpt-image-2**（照片 → 多视角/表情参考图）
- MiniMax / 豆包 TTS 或真人录音（台词音频）

### 1.2 两个决策问题

1. **Demo 编排用什么**：自研管道 vs n8n？
2. **中长期产品形态**：如何把当前项目模块化拆分？是否要设计通用的 Canvas + DAG 交互（参考 TapNow / Flowith NEO）？

### 1.3 结论速览

| 问题 | 结论 |
| --- | --- |
| Demo 编排 | **自研管道，不用 n8n**；复用现有 Provider/Job/Asset 基础设施 |
| 模块化 | **要做**，按 L0 Provider → L1 Job → L2 Asset → L3 DAG 顺序抽取为包，不做微服务化 |
| Canvas UI | **要做**，采用 React Flow + 「模板化受约束 Canvas」，而非完全自由画布 |
| 实施顺序 | Phase 0 脚本出片 → Phase 1 硬编码管道产品化 → Phase 2 模块化 → Phase 3 Canvas UI |

---

## 2. 现状分析：当前系统已是「模块化半成品」

漫剧工坊不是单体，而是**被产品形态锁死的五层能力栈**。真人数字人与漫剧的差异只在 L3 业务拓扑与 L4 UI。

| 层级 | 漫剧里的实现（现状代码） | 真人数字人复用度 |
| --- | --- | --- |
| **L0 Provider 抽象层** | `server/providers/*`：Seedance / gpt-image-2 / MiniMax / 豆包 / OpenAI-compatible；`keychain.ts` BYOK；`paid-aigc-confirmation.ts` HMAC 付费门禁；Provider revision 绑定 | ✅ 直接复用，**最大资产** |
| **L1 任务编排层** | `worker.ts` + `queue.ts` + `events.ts` + `job-retry-policy.ts`：通用持久 Job Worker、幂等、SSE、取消、重试、服务重启恢复 | ✅ 直接复用 |
| **L2 资产层** | `media.ts` / `asset-identity.ts` / `asset-locking.ts` / `asset-retention.ts`：MediaStore、Asset version/checksum、ETag、Range/下载、7 天保留策略 | ✅ 直接复用 |
| **L3 业务管道层** | `pipeline-production.ts` 硬编码 `speech → storyboard → timeline → export → quality` 五阶段 | ⚠️ 需替换为数字人 DAG |
| **L4 产品 UI 层** | React 工作台五阶段导航、OpenCut 时间线、`OneClickProductionPanel` | ⚠️ 重做为 Canvas（Phase 3） |

### 2.1 真人数字人脱口秀 DAG vs 漫剧 DAG

```
漫剧（现状）:
  原著 → 结构草稿 → 角色/场景资产 → 剧本+对白语音 → 分镜图
       → 逐镜视频(Seedance 2.0) → OpenCut 时间线 → 导出 → QC

真人数字人脱口秀（Demo）:
  演员照片 → 参考图集(gpt-image-2 edits: 正/侧/半身/表情)
           ┌──────────────────────────────┐
  台词稿 → TTS/真人录音 → 词级时间戳 sidecar │
           ↓                               │
  音频驱动 timing manifest(24fps) → 逐句 Seedance 2.5 首帧视频
           → FFmpeg concat + 字幕烧录 → 7 项 QC → 成片
```

### 2.2 现有代码对 Demo 关键需求的覆盖度

| Demo 需求 | 已有模块 | 备注 |
| --- | --- | --- |
| 照片 → 参考图（真实图片输入 edits） | `server/asset-image-edit.ts` | 已支持锁定参考图传给 `images/edits`，不支持时明确失败 |
| 音频驱动时长决策 | `server/shot-video-duration.ts`（`ShotVideoDurationDecision`） | 音频实测时长固化 24fps；短于 4s 裁切、超 15s 阻断拆镜 |
| 词级时间戳字幕 | `server/minimax-subtitle.ts` + `speech-subtitle.ts` | sidecar 安全下载/校验/持久化；无 sidecar 降级句级 |
| Seedance 首帧视频 + 幂等/轮询/下载 | `server/providers/seedance.ts` + `shot-video-generation.ts` | 需把模型版本切到 2.5；Agent Plan `/api/plan/v3` 已接线 |
| 付费 preflight/confirm | `server/paid-aigc-confirmation.ts` | HMAC token 绑定 source revision + Provider revision |
| 拼接导出 + 字幕烧录 | `server/export-render.ts`（FFmpeg） | 已支持混用、ASS 烧录、多比例、1080p |
| 质量可控证据 | `server/quality-check.ts` policy v2 七项 | 与 Asset checksum / revision 绑定 |

**结论：Demo 只需新写一份业务管道定义 + 最简入口，L0–L2 零改动。**

---

## 3. 决策一：为什么不用 n8n

考虑过用 n8n 做 Demo 编排，否决。理由：

1. **工程护栏即差异化**。Demo 要展示的核心卖点是「质量可控」：幂等提交、未知提交结果 fail-closed 不重复扣费、Asset checksum 全链路绑定、七项 QC 门禁。这些已在 `server/providers/seedance.ts`、`paid-aigc-confirmation.ts`、`quality-check.ts` 中实现，比 n8n 通用 HTTP 节点可靠得多。用 n8n 会把产品变成「调 HTTP 的胶水」，评审/客户看不到差异化。
2. **适配成本高**。n8n 节点无法消费 SQLite revision / Asset checksum 体系，需要再写一套适配层，等于多养一套系统。
3. **场景不匹配**。照片 → 数字人视频节点数 < 10，是线性 DAG，n8n 是杀鸡用牛刀。

**n8n 的正确定位**：未来私有化交付时，作为 L3 管道层的**外部触发器**（如 CRM Webhook 触发创建数字人项目），不是核心引擎。

---

## 4. 决策二：模块化拆分方案

### 4.1 拆分原则

把「业务拓扑」从「执行引擎」中抽出。**为代码复用而模块化，不为分布式而微服务化**——部署形态仍是单机 SQLite 单进程。

```
┌─────────────────────────────────────────────────┐
│         Pipeline Definition (声明式 JSON/TS)      │
│  nodes: [{id, type, inputs, outputs, config}]    │
│  edges: [{from, to, mapping}]                    │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│         DAG Executor（替代 pipeline-production）  │
│  - 拓扑排序 + 依赖就绪检查                          │
│  - 节点 = 一个 Job 模板（复用现有 Job Worker）      │
│  - 节点产物 = Asset revision + checksum           │
│  - 付费节点自动接入 preflight/confirm 门禁          │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│         Node Type Registry                       │
│  image.edit / tts.generate / video.seedance      │
│  timeline.materialize / export.ffmpeg / qc       │
│  每个节点类型对应 server/*.ts 中现有模块            │
└─────────────────────────────────────────────────┘
```

### 4.2 包拆分清单（按实施优先级）

| 顺序 | 包名 | 抽取来源 | 说明 |
| --- | --- | --- | --- |
| 1 | `@manju/provider-kit` | `server/providers/*` + `keychain.ts` + `paid-aigc-confirmation.ts` | Provider 目录、BYOK/BYOA、付费门禁；Demo 与未来所有产品共用 |
| 2 | `@manju/asset-store` | `media.ts` `asset-identity.ts` `asset-locking.ts` `asset-retention.ts` `safe-image-download.ts` | 资产版本/审计/安全下载/保留策略 |
| 3 | `@manju/job-runtime` | `worker.ts` `queue.ts` `events.ts` `job-retry-policy.ts` | 持久 Job + SSE + 幂等 + 重启恢复 |
| 4 | `@manju/dag-executor` | **新增**；吸收 `pipeline-production.ts` / `pipeline-run.ts` 的执行语义 | 拓扑执行、依赖就绪、过期传播 |
| 5 | `@manju/nodes-*` | `speech-generation.ts` `storyboard-image-generation.ts` `shot-video-generation.ts` `export-render.ts` `quality-check.ts` `asset-image-edit.ts` 等 | 每类节点一个包 |
| 6 | `@manju/canvas-ui` | 新建（React Flow） | 见 §5 |

### 4.3 关键设计决策

#### 4.3.1 节点间传递 Asset Reference，而非文件

```typescript
interface AssetRef {
  assetId: string
  version: number
  sha256: string
  metadata?: Record<string, unknown>
  // e.g. { durationMs: 4200, wordTimestampsAsset: AssetRef, fps: 24 }
}

interface NodeOutput {
  [port: string]: AssetRef
}
```

这是相对 n8n / ComfyUI 最大的差异化：**全链路不可变溯源**。任何下游产物都能回溯到精确的输入 Asset version + checksum + Provider revision。

#### 4.3.2 付费节点声明式接入门禁

```typescript
defineNode({
  type: 'video.seedance',
  billing: { provider: 'seedance', model: 'seedance-2.5', preflight: true },
  // DAG Executor 执行前自动调用 paid-aigc-confirmation 生成 HMAC token；
  // 未经确认的付费节点在 UI 与 API 两侧均不可放行
  ...
})
```

免费节点（LLM 理解、字幕物化、重排）默认 `billing: none`，沿用现有「LLM 免费、生成付费」的产品策略。

#### 4.3.3 节点定义用 TypeScript + Zod，不用 JSON Schema

```typescript
import { z } from 'zod'

export const seedanceVideoNode = defineNode({
  type: 'video.seedance',
  input: z.object({
    firstFrame: AssetRefSchema,
    audio: AssetRefSchema.optional(),
    durationDecision: DurationDecisionSchema, // 音频驱动 timing manifest
    prompt: z.string().max(2000),
  }),
  output: z.object({ video: AssetRefSchema }),
  billing: { provider: 'seedance', model: 'seedance-2.5', preflight: true },
  async run(ctx, input) {
    // 内部调用 @manju/provider-kit 的 seedance adapter
    // ctx 提供：Job 上下文、幂等键、MediaStore、进度上报
  },
})
```

同时满足：Canvas UI 渲染节点端口、服务端静态校验、类型安全的节点实现。JSON 序列化形态（供存储/前端）由 Zod schema 派生。

#### 4.3.4 Pipeline Definition 存为不可变 revision

管道定义本身（节点 + 边 + 参数）存入 SQLite 不可变 revision，与现有 Story/Timeline revision 同一套审计语义。采用/恢复历史管道定义会使下游产物 `stale`——复用现有过期传播机制。

#### 4.3.5 过期传播（stale propagation）规则

- 上游节点输出 Asset version 变化 → 直接下游节点状态置 `stale`
- 付费节点 stale → 必须重新 preflight/confirm，不允许静默复用旧确认
- 漫剧已有的「剧本修订 → 分镜/视频/导出/QC 过期」语义推广为 DAG 通用规则

---

## 5. 决策三：Canvas + DAG UI 设计

### 5.1 选型过程

候选交互范式：

| 方案 | 代表 | 评估 |
| --- | --- | --- |
| 固定阶段向导 | 漫剧现状五阶段 | 质量可控性最好，但无法支撑多业务；否决作为唯一形态 |
| 完全自由 Canvas | Flowith NEO / TapNow | 自由度高但用户易迷失，节点间契约弱，「质量可控」承诺难以工程化；否决 |
| 节点编辑器（图即程序） | ComfyUI | 面向技术用户，演员/MCN 客户不可用；否决 |
| **模板化受约束 Canvas** | （本方案） | 模板锁定骨架保证可控，模板内参数自由配置；**采纳** |

TapNow / Flowith 的核心教训：**完全自由的 Canvas 会让非技术用户迷失，且无法给产出质量背书**。目标客户（MCN、脱口秀厂牌、内容工作室）要的是「可控产出」，不是「自由创作」。

### 5.2 模板化 Canvas 形态

```
┌──────────────────────────────────────────────┐
│ 模板栏: [数字人脱口秀] [漫剧] [广告] [空白]      │
├──────────────────────────────────────────────┤
│                                              │
│   ┌────────┐   ┌──────────┐   ┌────────┐     │
│   │ 照片   │──▶│ 参考图集 │──▶│ 逐句   │     │
│   │ 上传   │   │ 生成     │   │ 视频   │     │
│   └────────┘   └──────────┘   └───┬────┘     │
│                                   │          │
│   ┌────────┐   ┌──────────┐       │          │
│   │ 台词稿 │──▶│ TTS/录音 │───────┘          │
│   └────────┘   └──────────┘                  │
│                       │                      │
│                  ┌────▼─────┐   ┌────────┐   │
│                  │ 拼接导出 │──▶│ QC 门禁│   │
│                  └──────────┘   └────────┘   │
│                                              │
│  选中节点 → 右侧面板: 参数/prompt/产物/QC      │
└──────────────────────────────────────────────┘
```

行为规则：

1. **模板模式**（默认）：骨架节点与边就位，核心节点（付费生成、QC 门禁）不可删除；用户只能上传素材、改参数、增挂可选节点（如额外参考图）
2. **空白模式**：完全自由画布，面向高级用户；导出前仍强制经过 QC 节点，否则产物锁定（与现有导出门禁一致）
3. **节点是活的**：悬停显示当前输出 Asset version + checksum；点击展开历史版本链（复用 `visual-asset-history.ts` / `shot-video-history.ts`）
4. **边即状态**：SSE 驱动边上动画表示 Job 运行中/失败/待确认；付费节点的边在未 confirm 前显示锁定态
5. **Canvas 状态即文档**：画布布局 + 参数存入不可变 revision 文档（同 `timeline_documents` 的 ETag/If-Match 语义）

### 5.3 技术选型

| 项 | 选型 | 理由 |
| --- | --- | --- |
| 画布库 | **React Flow (xyflow)** | 成熟、受控模式、自定义节点/边、TypeScript 友好；不自研 |
| 节点卡片 | 复用 `ShotVideoPanel` / `ShotMediaReviewPanel` 现有视觉 | 保持产品视觉一致性 |
| 状态同步 | 服务端 revision 文档 + SSE（复用 `events.ts`） | 不引入新的实时通道 |
| 布局持久化 | SQLite 新表或复用 documents 模式 | 与现有迁移/备份链一致 |

---

## 6. 落地路线图

### Phase 0：Demo 脚本（不动架构，~2-3 天）

- 新增 `scripts/demo-talkshow.ts`，硬编码调用链：
  照片 → `asset-image-edit`（参考图集）→ TTS → `shot-video-duration`（timing）→ `seedance.ts`（2.5 首帧逐句）→ `export-render`（concat+字幕）→ `quality-check`
- 输入：1 张照片 + 台词 txt；输出：成片 MP4 + QC 报告
- 无 UI，命令行可跑

**验收**：一位演员素材端到端出片，QC 七项通过，付费调用全部经过 preflight/confirm。

### Phase 1：Demo 产品化（~2 周）

- 新增 `server/digital-human-pipeline.ts`（**硬编码 DAG**，不抽象）
- 前端 `/digital-human` 路由，复用现有 Panel 组件（四步：素材 → 参考图 → 语音 → 视频/导出）
- Seedance 模型版本切 2.5，保留 2.0 配置项

**验收**：浏览器内从上传照片到下载成片全链路；刷新/重启恢复；未知提交结果 fail-closed。

### Phase 2：模块化（~1 个月）

- 按 §4.2 顺序抽取 L0–L2 为 workspace 包（npm workspaces，不发布 registry）
- 新增 `@manju/dag-executor`；把漫剧 `pipeline-production.ts` 与数字人管道改写为两份 Pipeline Definition
- 全量回归：现有 golden test、E2E、音频优先 golden 必须全绿

**验收**：两份业务定义跑在同一 executor 上；`pipeline-production.ts` 硬编码执行顺序删除。

### Phase 3：Canvas UI（~1 个月）

- 引入 React Flow，先做模板模式（只读骨架 + 可编辑参数），后做空白模式
- 数字人与漫剧两个模板上线；漫剧五阶段导航保留为「模板入口」

**验收**：模板内不可删核心节点；空白模式产物未过 QC 不可下载；Canvas revision 恢复语义与 timeline 一致。

---

## 7. 风险与边界

| 风险 | 缓解 |
| --- | --- |
| 抽象过早：Phase 2 前不要写 dag-executor | Phase 0/1 明确允许硬编码；两份硬编码管道是抽象的最佳输入 |
| React Flow 自由度过载 | 先只交付模板模式；空白模式延后并加 QC 强制门禁 |
| 数字人口型/表情质量不达演员预期 | Demo 先做「首帧 + 音频时长」基线；对口型作为后续节点类型（如接入专门 lip-sync Provider），不阻塞管道设计 |
| 包拆分破坏现有 golden/E2E | 每抽一个包跑全量测试；拆分期间不改任何行为语义 |
| n8n 诉求重现（客户要私有化自动化） | 对外暴露「创建项目 + 触发 Pipeline Definition」的 API/Webhook，由 n8n 做触发器而非引擎 |

---

## 8. 不做的事（Non-goals）

- 不做微服务化 / 分布式执行（单机单进程 SQLite 不变）
- 不做 ComfyUI 式面向技术用户的节点编程界面
- 不在 Canvas 上实现 OpenCut 时间线剪辑能力（时间线仍是独立阶段/节点）
- 不在 Phase 0-2 引入新的 Provider 计费路径；所有付费仍走现有 preflight/confirm
- 不发布 npm registry 包；workspace 内部包即可
