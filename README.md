# 漫剧工坊 MVP

本机单用户的 AI 漫剧生产工作台。产品视觉、信息架构和 React 组件保持漫剧工坊自己的实现；剪辑交互、命令、轨道约束和工程文档语义以固定版本的 OpenCut Classic 为内核，不照搬 OpenCut 页面，也不使用 iframe。

这里的“复用 OpenCut 后端”有明确边界：OpenCut 主仓库当前尚未交付成熟的 Editor API/Headless，`apps/api` 仍只是基础脚手架；Classic 也没有可直接部署的云端剪辑后端。因此本项目用极薄的 `ManjuStorageAdapter` 把 OpenCut 文档/命令语义接到 Express + SQLite。SQLite/API 是持久化 adapter，不是 OpenCut 原生后端，也不能另建一套平行剪辑规则。

详细范围、阶段门槛和 OpenCut 适配边界见 [`plan.md`](./plan.md)。

## 固定生产顺序

工作台只展示五个生产阶段：

```text
原著
→ 角色与场景
→ 剧本拆解 + 真实对白/旁白音频
→ 分镜图 + 按实测音频时长生成逐镜视频
→ OpenCut 剪辑 + 同源字幕 + 导出/QC
```

`audio` 仍作为第 3 阶段内部子页的兼容路由，不是第六个可见阶段。产品策略将**所有 LLM Provider 能力**视为对用户免费，包括文字生成、文本理解、逐句 AI 导演、AI 声线推荐、图片内容的视觉判断，以及全部 Agentic / 多模态编排；这类能力由用户显式点击后直接创建持久、幂等、绑定 Provider revision 的 Job，不显示计费预检/确认。**只有图片生成/编辑、TTS（含试听）与 Seedance 视频生成**保留付费 preflight/confirm。自动定时、字幕物化或 OpenCut 智能修复不会偷偷调用这些付费 Provider。当前角色/场景工作台仍使用原著阶段生成的结构草稿提取实体，并未伪造独立的“免剧本实体抽取”服务。

## 当前真实能力

- React/Vite 自有视觉工作台；新工作区不注入示例项目。支持粘贴原著或在浏览器本地读取 UTF-8 `.txt`/`.md`，再提交真实结构草稿任务。该草稿为第 2 阶段的角色/场景资产提供实体事实源；第 3 阶段再由用户拆解、修订并确认正式剧本与语音。
- Express `/api/v1`、SQLite **schema v14**、不可变 revision、通用持久 Job Worker、SSE、幂等、重试、取消和服务重启恢复。v13 新增逐镜分镜图/视频人工选版审计；v14 新增与时间线修订绑定的服务端媒体权威回执。普通保存不能伪造或继承回执；选版变化后只有真正消费当前 Shot 指针/Asset 版本与 checksum 的可信 reconcile 才能重新放行导出，手工替换画面不会被假签。采用或恢复历史版本会精确使时间线、导出与 QC 过期，分镜图换版还会解除依赖旧图的当前视频指针，但不会删除历史 Asset。一键生产保留五个持久步骤字段，但权威执行顺序已为 `speech → storyboard → timeline → export → quality`；新分镜子任务必须等待真实语音全部就绪。旧 `/api/project` 已返回 `410 LEGACY_API_REMOVED`，前端不再把 v0 项目快照作为第二事实来源。
- Codex Tools `gpt-5.5` Responses 与自定义 OpenAI-compatible 文本 Provider；所有 LLM/Agentic/多模态理解能力对用户免费，显式点击即创建持久幂等 Job。服务端严格校验结构化输出并原子写入 Scene/Shot/Dialogue。场景、对白、镜头属性、镜头新增/删除/同场排序和下游 `stale` 传播已接通。
- 剧本版本历史 UI 与真实恢复：读取不可变 revision，选择历史版本后通过 `If-Match` 创建新的审计修订；不会覆盖旧版本，并会使受影响的分镜、视频、导出与 QC 过期。
- Codex Tools `gpt-image-2`、自定义 OpenAI-compatible 图片 Provider、受控 MediaStore、Range/ETag Asset API。分镜任务固化 Scene/Shot/source revision，成功后原子回链 Shot，并保留重生成版本链。
- **全角色、地点、道具视觉资产工作台**：从当前结构草稿列出所有实体，按实体提交持久候选任务，显示进度/失败/重试、预览候选、锁定参考图，并保存 parent/version 链。锁定写入独立审计 revision、使下游产物过期；适用的锁定参考会作为真实图片传给 `images/edits`，不支持时明确失败而不是偷偷改成纯文本生成。
- MiniMax `speech-2.8-hd`、豆包语音 2.0 Agent Plan 与自定义 OpenAI-compatible Speech Adapter。逐句语音是持久且仍受付费确认保护的 `dialogue.speech.generate` Job，音频经真实时长探测后保存为本地 Asset 并回链 DialogueLine。MiniMax 词级时间戳 sidecar 会经过安全下载、校验并持久记录；无可用 sidecar 时保留已付费音频并明确降级为句级时段。角色详情读取当前 Provider 的受控真实音色目录，支持搜索、手动绑定与由当前文本 Provider 免费执行的 Agentic 主选/备选/场景表演指令；角色基础音色跨场景保持稳定，单句合成默认继承独立审计绑定，临时覆盖位于高级入口。
- **音频优先 timing manifest**：含对白/旁白的镜头在 Seedance 预检前必须具备当前 source revision 的全部语音 Asset。服务端将 Asset ID/version/checksum/实测时长按 24fps 固化为不可变 `ShotVideoDurationDecision`，并同时写入 Seedance Job/Asset 与 `manjuTimeline.audioDrivenTiming` 哈希清单。音频短于 4 秒时生成 Provider 最短源片后精确裁切；超过 15 秒阻断并要求拆镜，不变速、不截语音、不借下一镜补时长。
- **免费逐镜视觉 Agent**：只有用户显式点击“AI 视觉分析参考图”才会创建 `shot.video.reference.analyze` 持久 Job；请求使用稳定 `Idempotency-Key`，并固化当前剧本修订、选镜范围、受控候选图片的 Asset version/checksum 及支持 vision 的文本 Provider revision。Seedance 预检只接受 `referenceAnalysisJobId`，服务端据此读取已成功 Job 的权威输出并重新核对项目、分集、镜头、修订、候选素材与 Provider 绑定，客户端不能直接提交模型挑选出的 Asset 列表。未运行视觉分析时明确使用“确定性安全兜底（非视觉 Agent）”，只消费可验证槽位与当前镜分镜，不假装理解图片；视觉分析提交结果 unknown 时不会自动重提，用户主动重试仍复用原幂等键或明确发起新一轮。
- Seedance 2.0 逐镜视频执行链与自有 UI 已接线：BYOK、幂等提交、轮询、本地停止、外部 Task ID 持久化、服务重启续查、临时 URL 安全下载及本地视频 Asset 落盘。批量 UI 可在最多 24 个镜头上选择纯文字、首帧、严格首尾帧或多参考；默认生成时长由上述 timing manifest 决定，手动时长不得短于语音。服务端用同一 `Idempotency-Key` 完成无计费 preflight 和确认，固化 source/provider/Asset version/checksum 并防止未知提交结果重复扣费。设置中心明确区分 Agent Plan `/api/plan/v3`、方舟按量计费 `/api/v3` 与自定义兼容网关；前两者走 Ark 原生任务协议，自定义网关走 NewAPI `/v1/videos`，付费 POST 后绝不自动切换路径重提。未配置 Key 或未显式确认时不发起计费请求。
- 固定 OpenCut Classic commit 的受控源码提取、MIT/provenance 校验，以及 placement/snapping、碰撞、移动/更新/切分命令、24fps 裁切和 CommandManager 撤销/重做。OpenCut `SeekController`、`ZoomController`、`ElementInteractionController` 和 `ResizeController` 已经由漫剧自有 React 时间线转发事件；拖拽/跨轨、裁切和属性更新使用 OpenCut command，再通过 `ManjuStorageAdapter` 写入 SQLite 不可变修订。canonical timeline v2 codec 及 v1 迁移已由客户端、materializer 和 export 共享。
- OpenCut `PlaybackManager` 已用于时间线和预览播放时钟。共享、深度冻结的 `RenderSemanticPlan` 会把同一不可变 timeline/story revision 与 Asset version/SHA-256 固化为精确 24fps 的画面裁剪/fit、音频 gain/fade/role/ducking 和字幕边界，并对未知语义 fail-closed。自有预览已改为只读取该 plan；浏览器快速审片导出复用固定 OpenCut Classic `VideoCache`/`SceneExporter` 的 Mediabunny 生命周期，支持连续图片/视频、cover/contain、视频裁剪、音频裁剪/增益/淡化/角色/对白 ducking 与不重叠字幕。它会重新校验媒体字节 SHA-256，缺少 WebCodecs AVC/AAC 或 Mediabunny 能力时按钮保持禁用，不会切换格式伪成功。该能力仍只是 720p、最长 10 分钟的内存型审片 MP4，不是完整 effect/mask GPU compositor，也不替代正式 FFmpeg + QC。
- `timeline_documents` SQLite API、ETag/`If-Match` 冲突保护、不可变时间线 revision 与 `ManjuStorageAdapter` 串行保存。预览和导出打开前先 `flush()`，并接收同一个精确 revision/ETag snapshot。时间线历史 UI 可查看元数据，恢复必须携带 `If-Match` + `Idempotency-Key`，把目标快照复制为新 head 而不移动/删除旧修订；与恢复同一事务会使导出、QC 和 PipelineRun 过期。自动保存的 412 冲突不会静默覆盖：本地 document 保留为可复制/下载的救援 JSON，只能由用户显式采用远端，或在 canonical 校验后基于最新 head 另存新修订。
- 授权 BGM/SFX 可上传为持久 Asset，自由文本可在播放头写入文字轨。materialize/reconcile 会从精确语音 Asset 的词级 sidecar 自动物化托管字幕；无可靠 sidecar 时使用覆盖实测音频区间的整句 fallback。字幕通过 OpenCut `ReplaceManagedSubtitleCueSetCommand` 原子写入，固化语音 Asset、scene/shot/line、音频起点/裁剪/时长；已存在的有效手工 cue 不被覆盖，重复 reconcile 不制造新 revision。正式导出只消费时间线中已固化且来源可验证的 cue，不在导出时临时猜测时码。音频片段可以用 OpenCut 属性命令调整音量、淡入和淡出；FFmpeg 对对白区间执行确定性 BGM ducking。
- 持久 `export.render` Job 与 FFmpeg/ffprobe 正式渲染：只消费指定不可变时间线 revision，支持同一视觉轨内图片和 MP4/WebM 视频混用、视频源裁剪/探测、静态图硬切与可选推拉、字幕烧录、音频混音、16:9/9:16/1:1、720p/1080p、24fps、H.264 `yuv420p` 和 AAC 48kHz 双声道。导出配置还可把片头标题、片尾“本集完”落版和审片水印固化为现有时长内的 ASS 文字 overlay；它们不是额外时长的专业片头片尾动画。缺失 snapshot 媒体引用会失败，不再回退到当前可变 Shot。
- FFmpeg 导出失败后，Job 会持久限长、脱敏的 stderr、错误分类、无绝对路径的运行时审计摘要和不可变 Asset pin；媒体字节与临时目录仍在失败返回前清理。
- 持久 `quality.check` 与 `quality_reports`：policy v2 真实执行可解码性、ffprobe 规格、黑帧、静音、峰值、字幕时序和字幕安全区 7 项检查，并保存与导出 Asset checksum、时间线 revision、剧本 revision 绑定的证据。旧 5 项报告不能授权。导出二进制的 `GET`、`HEAD` 和 Range 请求会在服务端重新验证最新且未过期的通过报告；未 QC/失败时锁定，绑定过期时冲突，通用 Asset content 路由也不能绕过 `export.video` 门禁。
- 自有视觉的“一键生产”面板按语音优先顺序显示五步持久进度，可刷新恢复和二次确认取消。付费创建前必须调用服务端权威 preflight；HMAC 确认令牌同时绑定 source revision、缺失/已就绪目标、计费数量和实际 Provider revision/model。无计费的定时、字幕物化和 OpenCut 修复不会绕过该确认门禁发起 AIGC。
- 已有一条完全离线的真实 HTTP golden test：预置合法 Story、6 个镜头、真 PNG 与真 48kHz 音频，先通过公开 API 完成手动时间线导出/QC，再走权威 preflight 与完整 PipelineRun；全程执行两次真实 FFmpeg、两次 7 项 QC，并验证五步不可变绑定、零付费 Provider 调用、QC 前后 `GET`/`HEAD`/Range 门禁及两次 runtime 重启恢复。这是服务端生产链证据，不等于从空项目开始的浏览器 E2E。
- 完整离线浏览器 E2E 从新临时 SQLite 和空原著编辑器开始，通过真实 HTTP/Job/MediaStore/OpenCut adapter/FFmpeg/QC/下载链生成并用 ffprobe 验证 30 秒 H.264/AAC MP4；文本/图片边界使用仅 E2E 可用的确定性 Provider，浏览器和服务端都 fail-closed 禁止外网，不会命中付费 Provider。同一流程还以 1024×600 验证 Seedance 批量弹窗和无计费 preflight。
- `test:e2e:audio-first` 是从空临时 SQLite 开始的统一五阶段 golden：输入 1,000+ 字原著并生成 6 镜剧本；通过真实 UI 生成并人工锁定角色/场景候选、拆分确认并绑定正/侧/背三视图；编辑一项镜头属性与一句对白，证明旧修订的下游引用不可复用；为新修订重新固化视觉资产，生成 6 条不等长本地系统 TTS 和携带精确角色槽位/场景参考的 6 张分镜；完成 6 镜 Seedance 无计费权威预检、同源字幕、Agentic OpenCut 音频驱动重排、1080p 正式 FFmpeg、7 项 QC 和下载，并验证页面刷新与进程硬重启后的精确恢复。文本/图片仍为仅 E2E 确定性边界，Seedance 不会确认或提交付费视频任务，不是真实付费 Provider 验收证据。
- Provider 设置中心：Codex Tools BYOA 状态、文本/图片/语音自定义 BYOK、MiniMax、豆包语音 2.0、Seedance Agent Plan/按量计费/自定义网关、macOS Keychain、非生成式连接测试和默认 Provider。
- 运维健康检查会重新验证 SQLite、Worker 以及媒体目录的非符号链接边界和实际可写性；外部 Provider 以独立 capability readiness 返回。7 天资产保留策略默认只生成 dry-run 计划；apply 必须回传精确 `planFingerprint` 和 boot-scoped 确认令牌。执行使用安全路径/符号链接复核、持久隔离日志、`BEGIN IMMEDIATE` 二次引用检查、整批 DB 删除和启动崩溃恢复；上传、legacy/import、renderer/export 与任何当前被引用资产仍受保护。
- 旧 `runtime/state.json` 只读导入；数据库迁移前自动创建并校验 SQLite 物理备份，同时从该快照生成可独立读取、无密钥、带 SHA-256 的 `runtime/media-index-backups/*.json`。任一备份产物验证失败都会阻止迁移。路径穿越、媒体伪装、SSRF、重定向、DNS rebinding、下载大小和日志泄密均有防护。

## 尚未完成（当前仍不是完整 MVP）

- 完整 OpenCut effect/mask/动画 compositor。当前严格子集已包含 opacity fade、单个矩形/椭圆硬边 mask（保留内部或反向保留外部）和静态图片中心统一缩放，45 秒 9:16 Chrome 峰值内存/音画 Spike 与同 snapshot 双编码文件级对照已通过；feather/stroke/旋转/缩放/多 mask 及其他 effect/动画仍 fail-closed。
- 字幕字体、位置和动画等完整排版能力仍取决于 compositor；现有 MVP 已完成词级文本/时码校订、来源失效、OpenCut 原子持久化、正式烧录与时序/安全区 QC。
- 专业片头片尾动画、模板化品牌包和完整转场/effect/mask 工作流；现有标题/落版/水印只是正式导出的文字 overlay。
- 完整多参考组合人工审核和可量化一致性检查。三视图本地拆分、真实图片 edit/variation 和锁定参考链已实现，但仍不等于“彻底解决人物一致性”。
- 新音频优先 timing manifest 的 6–12 镜真实人工验收：必须确认对白/旁白不跨镜、字幕存在且同源、短源片的本镜裁切/补尾符合导演意图。旧 8 镜成片只证明可渲染和规格 QC，不算新方案验收。
- 官方 Ark 最低成本单镜付费 smoke 已成功保存并经 ffprobe 验证；仍需完成 Seedance 6–12 镜批量人工审核。常规自动测试继续只使用 Stub/无计费 preflight。
- 离线浏览器黄金路径以及页面刷新、UI 取消和运行中服务硬重启的组合故障路径均已通过；付费任务未知提交结果仍按 fail-closed 处理，不自动重提。

## 本地运行

```bash
npm install
npm run dev
```

开发模式同时启动：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:8788`

Vite 将 `/api` 和旧版 `/generated` 路径代理到 API。

单进程生产模式：

```bash
npm run build
npm start
```

`npm start` 默认在 `http://127.0.0.1:5173` 同时托管 Web 与 API。

需要关闭终端后仍持续运行时，使用受管后台服务：

```bash
npm run build
npm run server:start
npm run server:status
```

`server:start` 与 `server:ensure` 均为幂等操作；`server:ensure` 会在已记录的本项目进程意外退出后恢复服务，`server:restart` 执行安全重启，`server:stop` 停止服务。管理器将 PID、启动身份和日志写入被 Git 忽略的 `runtime/`，启动后必须通过 `/api/health` 才报告成功。停止前会同时核验 PID 与本项目服务入口；如果 5173 被未知进程占用，只报告为非受管服务或启动失败，不会终止未知进程。SQLite、媒体 Asset 与 Job 均位于持久 `runtime/`，正常重启不会删除或重建它们。

## Provider 配置

1. Codex Tools 文本/图片代理默认地址为 `http://127.0.0.1:8787`。
2. 服务优先读取 `CODEX_TOOLS_API_KEY`；未设置时，macOS 读取 `~/Library/Application Support/com.carry.codex-tools/api-proxy.key`。
3. 默认文本模型为 `gpt-5.5`，默认图片模型为 `gpt-image-2`。
4. MiniMax、豆包语音、自定义 OpenAI-compatible Provider 和 Seedance 的真实 API Key 只通过设置中心写入 macOS Keychain。Seedance 可选择 Agent Plan `/api/plan/v3`、按量计费 `/api/v3` 或经审核的 NewAPI HTTPS Base URL；前两者的连接测试只读取任务列表，不创建视频。豆包语音固定使用 Agent Plan HTTP 地址与 `seed-tts-2.0` Resource ID，连接测试使用保留的无效音色验证鉴权，不生成音频。

不要把密钥写入代码、项目 JSON、SQLite、日志、`.env` 实值文件或 Git。

## 主要 API

退役接口：

| 方法 | 路径 | 当前行为 |
| --- | --- | --- |
| 任意 | `/api/project` | `410 LEGACY_API_REMOVED`；必须使用 `/api/v1` 项目、分集和时间线资源 |

健康、项目与剧本：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health`、`/health/live`、`/health/ready` | 服务、数据库、Worker 与依赖状态 |
| `POST` | `/api/v1/maintenance/assets/retention` | 默认生成 7 天未引用中间资产 dry-run 计划；`dryRun:false` 必须提交该计划的 fingerprint 与确认令牌 |
| `GET` / `POST` | `/api/v1/projects` | 项目列表与创建 |
| `GET` / `PATCH` | `/api/v1/projects/:projectId` | 项目读取与带 ETag 更新 |
| `GET` | `/api/v1/projects/:projectId/revisions` | 不可变 revision 历史 |
| `POST` | `/api/v1/projects/:projectId/revisions/:revisionId/restore` | 恢复项目 revision |
| `POST` | `/api/v1/projects/:projectId/episodes` | 创建分集与保存原著 |
| `GET` / `PATCH` | `/api/v1/episodes/:episodeId` | 分集配置与 revision |
| `GET` | `/api/v1/episodes/:episodeId/story` | 当前结构剧本 |
| `POST` | `/api/v1/episodes/:episodeId/story-generations` | 结构剧本生成 |
| `POST` | `/api/v1/episodes/:episodeId/story/revisions/:revisionId/restore` | 以新审计 revision 恢复历史剧本 |
| `PATCH` | `/api/v1/scenes/:sceneId`、`/api/v1/shots/:shotId` | 场景、对白和镜头编辑 |
| `POST` / `DELETE` | `/api/v1/shots*` | 镜头新增、排序与删除 |

资产与 AIGC：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/episodes/:episodeId/visual-asset-targets` | 全角色、地点、道具工作台目标 |
| `POST` | `/api/v1/assets/image-generations` | 图片/分镜/实体候选持久任务 |
| `POST` | `/api/v1/assets/:assetId/lock` | 锁定实体候选并写审计 revision |
| `GET` | `/api/v1/assets*` | 媒体元数据与受控内容 |
| `POST` | `/api/v1/dialogue-lines/:lineId/speech-generations` | MiniMax、IndexTTS2 或自定义 Speech 逐句任务 |
| `POST` | `/api/v1/episodes/:episodeId/video-reference-analyses` | 显式创建免费的持久逐镜视觉分析 Job |
| `POST` | `/api/v1/episodes/:episodeId/video-generations/preflight` | Seedance 批量权威读取与短期确认令牌（不计费） |
| `POST` | `/api/v1/episodes/:episodeId/video-generations` | 使用同一 `Idempotency-Key` 确认并原子创建 Seedance 批量子 Job |
| `POST` | `/api/v1/shots/:shotId/video-generations` | 历史单镜幂等回放；新付费任务必须使用上述 preflight/批量路由 |
| `GET` / `POST` | `/api/v1/shots/:shotId/media-review` | 读取真实分镜图/视频候选、不可变选版历史，并以 `If-Match` + 幂等键采用、拒绝或恢复版本；不调用 Provider |
| `POST` | `/api/v1/assets/uploads/audio` | 上传并探测分集所属 BGM/SFX Asset |

剪辑、导出与 QC：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `PUT` | `/api/v1/episodes/:episodeId/timeline-document` | 时间线读取、保存与不可变 revision |
| `POST` | `/api/v1/episodes/:episodeId/timeline-document/materialize` | 从当前剧本创建时间线 |
| `POST` | `/api/v1/episodes/:episodeId/timeline-document/reconcile` | 保留人工剪辑并对账剧本/媒体变化 |
| `GET` | `/api/v1/timeline-documents/:documentId/revisions` | 时间线 revision 历史 |
| `POST` | `/api/v1/episodes/:episodeId/timeline-document/revisions/:revisionId/restore` | 以新 revision 恢复历史时间线（If-Match + 幂等键） |
| `POST` | `/api/v1/episodes/:episodeId/exports` | 固化 revision 并提交 FFmpeg 导出 |
| `GET` | `/api/v1/exports/:exportId` | 导出记录、输出 Asset 与下载 URL |
| `POST` | `/api/v1/exports/:exportId/quality-checks` | 提交持久真实 QC |
| `GET` | `/api/v1/quality-reports/:reportId` | 读取 QC 证据与结果 |
| `GET` / `HEAD` | `/api/v1/exports/:exportId/download` | 受控 MP4 下载（含 Range；服务端强制验证未过期 QC） |
| `POST` | `/api/v1/episodes/:episodeId/pipeline-runs/preflight` | 读取权威缺失/计费数量并签发短期确认令牌 |
| `POST` | `/api/v1/episodes/:episodeId/pipeline-runs` | 带 `Idempotency-Key` 和 preflight 令牌创建五步生产流水线 |
| `GET` | `/api/v1/pipeline-runs`、`/api/v1/pipeline-runs/:id` | 恢复分集生产历史与当前进度 |
| `POST` | `/api/v1/pipeline-runs/:id/cancel` | 终止父任务并取消所有活跃子 Job |
| `GET` / `POST` | `/api/v1/jobs*` | Job 查询、重试与取消 |
| `GET` / `PUT` | `/api/v1/providers*` | Provider 设置、凭据、测试和默认选择 |
| `GET` | `/api/v1/events?projectId=...` | SSE 状态事件 |

付费创建接口必须带稳定的 `Idempotency-Key`。Pipeline 创建还必须先获得对当前请求配置精确签名的 `confirmationToken`；进程重启、素材、源修订或 Provider 改变后必须重新预检。免费的 LLM/Agentic/多模态 Job 同样必须持久化幂等键与 Provider revision；提交结果 unknown 时只允许用原键精确查询/重放，系统不得换键或跨 Provider 自动重提。受保护的项目、剧本、资产锁定和时间线写入必须携带最近响应的 `ETag` 作为 `If-Match`；缺失返回 428，版本过期返回 412。

## 数据与恢复

- 数据库：`runtime/manju.sqlite`
- 新媒体：`runtime/media/<projectId>/...`
- 旧图片：`runtime/generated/`（迁移后只读兼容）
- 迁移备份：`runtime/backups/*.sqlite`
- 迁移媒体索引：`runtime/media-index-backups/*.json`

`runtime/state.json` 不会被覆盖或删除。数据库升级会先用 SQLite `VACUUM INTO` 创建权限为 `0600` 的物理备份，通过 `quick_check` 与 schema version 校验，再从该快照生成带 payload SHA-256 的独立媒体索引。两种产物必须同时验证成功，否则不执行迁移。

## IndexTTS2 本地语音

- 内置 `indextts-speech` Provider，默认连接 `http://127.0.0.1:7861`，模型名为 `IndexTTS-2`。
- FastAPI Sidecar 位于 `apps/indextts-sidecar/`；Apple Silicon 默认使用 MLX 8-bit 后端，提供鉴权健康检查、稳定声线目录和同步 WAV/MP3 合成，不依赖 Gradio 私有路由。
- 角色和项目旁白均可从真实 Sidecar 声线目录手动选择、AI 选角、生成独立试听，并以不可变 Provider revision/目录指纹继承到正式逐句合成和一键生产。
- Sidecar 必须配置完整 MLX IndexTTS2 权重、至少一个参考 WAV、`voices.json` 与独立 Bearer Token；首次合成会自动产生可复用的声线 `.npz` 条件缓存。缺少任一项时连接测试失败关闭，不会回退到 Mock 或任意文本 `voice_id`。

## OpenCut 集成边界

- 固定上游：OpenCut Classic commit `cf5e79e919144200294fb9fed22a222592a0aeea`，保留 MIT LICENSE、第三方声明和文件级 provenance/hash。
- 产品约束：漫剧工坊自有视觉；OpenCut UX controller、command、manager 和 document semantics 直接复用。React 组件只负责渲染与事件桥，不应保留另一套剪辑算法；自动化架构测试会拒绝业务源码直连 OpenCut 内部页面/样式，也会拒绝 UI-neutral boundary 导入 React、Next 或 CSS。
- 当前已确认复用：时间线/轨道领域类型、placement/snapping、碰撞、移动/更新/切分命令、裁切规则、CommandManager、PlaybackManager、Seek/Zoom/ElementInteraction/Resize controller 事件桥、`VideoCache`/`SceneExporter` 的顺序解码与 Mediabunny 输出生命周期，以及客户端/materializer/export 共用的 canonical document codec。浏览器层只适配 Asset 与严格语义计划，不复用 OpenCut UI/皮肤。
- 当前持久化：`ManjuStorageAdapter` + Express/SQLite 是 OpenCut 语义的薄 adapter；`timeline_documents` 是可恢复事实来源。Classic IndexedDB/OPFS 未来最多作为断网草稿，不能成为唯一工程数据。
- 当前预览/快导：共同消费一次 `flush()` 得到的精确 revision 和同一 `RenderSemanticPlan`；严格子集可预览并生成 720p 浏览器审片 MP4，unsupported timeline/codec/Asset pin 均 fail-closed。仍不是完整 OpenCut compositor，正式发布继续使用持久 FFmpeg/QC。
- 2026-07-14 审计的 OpenCut 主仓库 `main` HEAD `bab8af831b354a0b5a98a4a6e818ab7d633b94df` 仍在重写，Editor API/Headless 属未来能力，`apps/api` 只有基础脚手架，不能被描述为可直接复用的云端剪辑后端。
- 当前 `ffmpeg-static` macOS arm64 二进制报告 `--enable-nonfree`，只能用于本机内部 MVP 验证。运行时已优先解析显式/随包审计二进制，`npm run build:release` 会复核来源、哈希、实际配置、许可证/对应源码、所需 codec/filter 和真实 FFmpeg smoke，并拒绝 development fallback；仓库尚未提供合规替换二进制，因此可再分发安装包仍失败关闭。构建交接见 `third_party/ffmpeg/BUILD.md`。
- 发行构建的 receipt 绑定 manifest SHA-256 与完整 smoke 列表。`npm run start:release` 会在监听端口前重验二进制、配方/许可证/对应源码哈希和 receipt；常规 `npm start` 仍保留开发 fallback。这是失败关闭的工程门禁，不表示仓库已有可再分发二进制。

## 验证

```bash
npm test
npm run build
npm run test:e2e:offline
npm run test:e2e:audio-first
```

仓库包含 Server、Client/Adapter、OpenCut 受控提取、Seedance/MiniMax Stub、音频优先 timing manifest、同源字幕、共享 snapshot、音频混音、QC 和真实 MP4 的自动化测试。离线 HTTP golden 已覆盖 Pipeline preflight/五步编排、真 FFmpeg/QC、QC 字节门禁与服务重启恢复；45 秒 9:16 Chrome 性能/音画 Spike 和同 snapshot 浏览器/FFmpeg 双编码文件级对照已通过。这些证据仍不代表完整 compositor、新 timing manifest 的真实 6–12 镜人工音画/字幕验收、MiniMax 候选试听或 Seedance 批量质量审核已经完成。

当前是仅监听 `127.0.0.1` 的本机研发版本，完整 MVP 尚未达成，也未具备公网部署所需的登录、多租户、CSRF/CORS、用量限制与审计能力。
