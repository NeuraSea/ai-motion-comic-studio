# 漫剧 MVP 最终验收交接单

> 状态：工程与零计费验收已通过；不得把本文档中剩余的付费 Provider 调用或人工盲审写成“已完成”。  
> 更新：2026-07-18（Asia/Shanghai）

## 1. 当前权威样片

| 权威项 | 当前值 |
| --- | --- |
| Project | `jinxue-changan-ep03` |
| Episode | `jinxue-changan-ep03:episode:1` |
| Story revision | `84ef7e13-6212-4194-8670-914838536081` |
| OpenCut timeline revision | `2dba3bec-dd14-4d64-846e-8d9f83904d24` |
| 正式导出 | `4328798f-c153-4f40-a41f-4c22e12ccfc5`（`succeeded`） |
| 导出 Asset | `b1342dea-f380-469a-a703-e23e05a2fe98` |
| QC report | `01247703-4c3d-402c-99c7-9e2168c0e971`（7 项全过） |
| Release review | `3e7be01e-903a-410e-8ef1-680cfe79551c`（`approve`） |

这条权威链已证明：真实 MiniMax 音频→音频驱动镜长→当前 Seedance 视频→OpenCut 时间线→1080p FFmpeg→7 项 QC→完整播放人工发行批准→受控下载的基础闭环可用。它不能替代 Seedance 单变量 A/B 盲审。

## 2. Seedance candidate 身份清单

以下 8 个 Job 均为当前 Story revision，并固定 `seedance-video` / `doubao-seedance-2-0-260128` / Provider revision `3` / `1080p` / `16:9` / `sfx_only` / `seedance-compact-v1`。一次只读 inspect 已验证 Job、Provider Task、Asset、时长清单、输出文件和参考图文件的不可变身份。

| Shot | Candidate Job | Candidate Asset | 参考策略 |
| --- | --- | --- | --- |
| `sh0` | `db6bfe43-b008-4e18-9672-3283bbb08f21` | `012b3e81-b68f-40a4-a61e-973ea27f171f` | multi-reference |
| `sh1` | `2a9f09f9-998e-4898-b9c1-29e6c5f1a2f4` | `e28eea57-761e-4242-9344-4e43bc7f6bf5` | first-frame |
| `sh2` | `6167b26d-6042-4a03-a9c6-034881d767f4` | `b568a96a-23b0-40d4-aa3f-33043e0aef15` | multi-reference |
| `sh3` | `9fee013b-76f4-4b64-b38e-4bfd98db27d0` | `eb415a9f-0a94-49d9-8cee-00c0702d5292` | multi-reference |
| `sh4` | `0edfdc1f-4b60-41d9-ac95-2d64bf30be2b` | `6e99c781-ef23-4aa2-ad0b-77a30f1f4ec5` | first-frame |
| `sh5` | `3fcac01b-3ea8-4509-8043-2bf134eabe1b` | `6894d4c6-21b3-47cc-988f-41df4a678de0` | multi-reference |
| `sh6` | `275e7df1-3359-4a86-9ba3-c65b295479bc` | `fc800863-18da-4b08-995a-5563719de875` | multi-reference |
| `sh7` | `41040952-2876-4deb-b325-28219652a478` | `d18e699e-7b45-435c-aa45-21a71bd1ec45` | multi-reference |

下面命令只读 SQLite 和本地文件，不会提交 Provider：

```bash
npm run prepare:seedance-golden -- \
  --inspect \
  --episode 'jinxue-changan-ep03:episode:1'
```

当前期望结果：`eligible = 8`、旧 Story Job `rejected = 10`、`providerSubmissions = 0`。

## 3. 剩余外部验收 A：独立 Seedance baseline

### 3.0 Agent Plan 切换后的身份边界（2026-07-16）

当前可执行 Seedance 已切换为官方 Agent Plan：`https://ark.cn-beijing.volces.com/api/plan/v3`、模型 `doubao-seedance-2.0`、Provider revision `4`，健康检查通过。第 2 节的 8 个既有 candidate 仍是有效、可追溯的历史候选，但它们固定为 Provider revision `3` / `doubao-seedance-2-0-260128`，不能与 r4 Agent Plan 新生成的 baseline 组成“仅 Prompt 策略不同”的 Golden。

因此继续使用 Agent Plan 时，正确方案是先在 r4 下补齐 8 个 `seedance-compact-v1` candidate，再新建同一 r4 下的 8 个 `seedance-verbose-baseline-v1` baseline；不得只生成 r4 baseline 后与旧 r3 candidate 配对。当前 r4 已成功 2 个 candidate，所以配额恢复后剩余付费目标为 6 个 r4 candidate + 8 个 r4 baseline。分镜页 Golden 卡片已加入 Provider/model/revision 身份门禁，发现这种漂移时会禁用 baseline 按钮，并提供“准备当前 Provider candidate”的安全入口。

已真实执行两轮零计费 HTTP 预检：compact 与 verbose 均为 8 镜、59 秒、1080p、`sfx_only`、Provider r4 / `doubao-seedance-2.0`；除 Prompt compiler、Prompt 文本及 compiler notices 外，顶层控制字段和逐镜 duration/reference 决策均无差异。预检前后没有新增 Job，`providerSubmissions = 0`；确认令牌未保存，也没有提交 Provider。

### 3.0.1 Agent Plan 当前真实进度（2026-07-18）

只读核对本地 SQLite、Provider 绑定和方舟任务列表后，当前 Story/r4 不能写成“8 个 candidate 已完成”：

| Shot | r4 compact Job | Provider Task | Asset | 状态 |
| --- | --- | --- | --- | --- |
| `sh0` | `cb042325-b0c6-4abb-bf1e-8bcffe006157` | `cgt-20260716124143-bkb6j` | `5066d691-cef5-4b2e-93a4-d8902ad9d9dc` | 成功 |
| `sh1` | `dc57cfaa-b3a6-427e-9b26-29253f8208fb` | `cgt-20260716124640-z4qtq` | `c8d2b6ff-4b0c-41d9-a455-ad32a53ba1c4` | 成功 |
| `sh2`–`sh7` | 六个当前 Story/r4 Job | 无 | 无 | 本地提交结果曾为 unknown；后续只读任务列表未发现对应新 Task，禁止自动重提 |

- 当前 Story/r4 compact candidate：`2/8`；r4 verbose baseline：`0/8`。
- 2026-07-18 21:57（Asia/Shanghai）再次执行平台内置只读连接探针；它仅发送带当前模型过滤的任务列表 `GET`，健康结果为“当前模型可见任务 `10` 个”。总数与前次逐项核对一致，仍没有新 Task 或重复计费证据。该探针证明 Key、Agent Plan 路由和列表权限可用，**不能**证明创建配额已经恢复；验证配额需要新的付费创建请求，系统不会擅自发送。
- 另一 Story revision `93ffad60-…` 下的 8 个 r4 成功 Job 不能迁入当前 Story；当前 Story 的 8 个 r3 candidate 也不能与 r4 baseline 混配。
- 单镜 Seedance 台词试听 Job `ec6cd0bb-15cf-4685-b7a2-56018d8ca142` 在创建前被同一 429 明确拒绝，无 Provider Task/Asset。
- 外部配额恢复后，仍需对缺失的 6 个 r4 candidate 重新做免费预检并取得用户明确付费确认；不得自动重提。完成 `8/8` r4 candidate 后，才可创建 `8/8` r4 baseline。

平台现已把“Seedance 同步台词试听”设为 `evaluation_only`。服务端把 Story 的说话人和逐字台词写入受控 spec/Prompt，禁止 BGM、额外旁白和额外对白；若 Provider 成功，只保存独立不可变候选 Asset，不会覆盖当前 Shot 或 OpenCut 时间线，必须在镜头选版中人工试听后显式采纳。该发布方式同样进入免费预检、确认 MAC、批次 fingerprint 和持久 Job。

### 3.1 比较设计

- 声明的唯一比较轴：`prompt_strategy`。
- candidate：当前 `seedance-compact-v1`。
- baseline：独立长 Prompt/人工基线策略；不得修改其他控制变量。
- 每镜 baseline 必须是新的 Job、新的 Provider Task 和新的 Asset，不得借用上表 candidate，也不得使用那 10 个旧 Story Job。
- 必须逐镜保持相同 model、Provider revision、resolution、aspect ratio、`sfx_only`、音频 timing manifest、Provider 时长、参考图身份/顺序/角色和生成音频开关。
- 为闭合当前 8 镜 MVP，应生成 8 个 baseline；验证器虽允许 6–12 镜，只评 6 镜不得宣称 8 镜样片已完成 A/B。

### 3.2 平台内创建方式

在“分镜与逐镜视频”的 **Seedance Golden 验收**卡片中，先核对 candidate 与当前 Provider 身份。卡片的主分子只统计当前 `providerId + model + configRevision` 的成功 candidate；旧 Provider 成功结果另列为历史证据，不会与当前 Job 混算。若显示 Provider 漂移或未补齐，先点击“准备当前 Provider candidate”；8 个当前 Provider candidate 成功后，才点击“准备 A/B 长 Prompt baseline”。卡片直接读取当前 Story 的持久 Job，逐镜展示 candidate、baseline、运行中和失败状态；它不会用旧修订、旧 Provider 或既有生产视频冒充 baseline。两个入口都只打开批量生成工作台，并预置当前 8 镜全选、`1080p` 和“仅环境音 / 动作音”；candidate 使用 `seedance-compact-v1`，baseline 使用 `seedance-verbose-baseline-v1`，不会自动预检、建单或重提失败任务。

在打开的“逐镜视频批量生成”工作台中：

1. 核对预置的 8 个镜头、参考策略、`1080p` 与“仅环境音 / 动作音”。
2. 核对 **Prompt 策略**已选择“**A/B 长 Prompt 基线**（`seedance-verbose-baseline-v1`）”。
3. 先运行免费预检，逐镜展开“实际 Prompt”确认 compiler 版本。
4. 预检会继续固定模型、Provider revision、参考图身份/顺序、audio timing、画幅、分辨率和声音策略；确认令牌也绑定 Prompt 策略，切换策略后旧令牌不可建单。
5. 此模式不会复用 candidate 结果；只有下一步的用户明确确认才会创建独立计费 Job。

### 3.3 费用安全门禁

1. 先在 UI 查看无计费权威预检。
2. 只有用户明确确认这 8 个 baseline 付费任务后才能建单。
3. 同一意图的网络重试必须复用原 `Idempotency-Key`；未确认提交结果时不得换键重提。
4. 不得为了“补齐证据”自动创建付费任务。

2026-07-16 已对上表 8 个 candidate 执行一次真实 HTTP **verbose baseline 免费预检**：

- `billableTaskCount = 8`、请求总时长 `59` 秒；8 镜均为 `seedance-verbose-baseline-v1`。
- 逐镜对照 candidate 的镜头/场景、Provider/Provider revision/模型、分辨率、声音策略、`generateAudio`、Provider/时间线时长、完整 timing decision、参考 Asset/version/checksum/顺序、source revision，共 17 类控制字段，`mismatches = 0`。
- 项目 Job 数量预检前后均为 `100`，`createdJobs = 0`；没有发送付费确认，也没有调用 Seedance Provider。
- 预检返回的短期确认令牌未保存且不会自动提交；用户正式确认前必须在 UI 重新预检。

2026-07-16 用户明确确认后，平台以一个批次原子创建了 8 个
`seedance-verbose-baseline-v1`、`evaluation_only` Job（总请求时长 59 秒）。
`evaluation_only` 只允许保存独立验收 Asset，不会替换生产 Shot 的当前视频指针。
方舟随后对 8 次创建请求全部明确返回 HTTP `403` / `AccountOverdueError`，且没有返回任何
Provider Task ID；因此这 8 条均不是可用于盲审的成功 baseline，也没有生成视频 Asset：

| 镜头 | Job | 结果 |
| --- | --- | --- |
| `sh0` | `ded44d2d-4a02-464d-8854-9144beed5912` | `PROVIDER_BILLING_UNAVAILABLE` |
| `sh1` | `f65e4cf5-6f0a-44ec-8e45-31a10def2e39` | `PROVIDER_BILLING_UNAVAILABLE` |
| `sh2` | `5a9debfa-5f49-40fe-b50e-5f4ef7bc61e4` | `PROVIDER_BILLING_UNAVAILABLE` |
| `sh3` | `8f1314b5-8e44-4f51-9173-1cc576d28ac0` | `PROVIDER_BILLING_UNAVAILABLE` |
| `sh4` | `2645a382-833a-4f4f-a321-86fd70348cf0` | `PROVIDER_BILLING_UNAVAILABLE` |
| `sh5` | `0c63635b-3fd5-4ce1-95c2-8c45e0b1fa20` | `PROVIDER_BILLING_UNAVAILABLE` |
| `sh6` | `a96ef00e-c1eb-4ad7-89bf-184f0b92c85b` | `PROVIDER_BILLING_UNAVAILABLE` |
| `sh7` | `18597114-a92f-46a2-96f8-8397d4181fef` | `PROVIDER_BILLING_UNAVAILABLE` |

服务端已修正历史错误投影：持久化诊断为上述明确 403 的 Job 不再显示成
`PROVIDER_SUBMISSION_OUTCOME_UNKNOWN`，也不会要求去控制台猜测是否已建单。恢复方舟余额或授信后，
必须重新执行免费预检并取得用户新的付费确认；系统不会自动重提本批次。

分镜页 Golden 卡片会把这批持久错误明确显示为 `403 AccountOverdueError`，并提供“检查 Seedance 配置”入口；该入口只打开 Provider 设置，不会测试连接、预检或提交付费任务。

### 3.4 产生盲审包

在 8 个 baseline Job 全部成功后，按 [Seedance 真实 Golden 验收](./seedance-golden-evaluation.md) 运行准备器，为每个 `candidate-job,baseline-job` 传入一个 `--pair`：

```bash
npm run prepare:seedance-golden -- \
  --episode 'jinxue-changan-ep03:episode:1' \
  --name 'seedance-compact-v1-vs-verbose-baseline-v1' \
  --axis prompt_strategy \
  --pair '<candidate-job-sh0>,<baseline-job-sh0>' \
  --pair '<candidate-job-sh1>,<baseline-job-sh1>' \
  --pair '<candidate-job-sh2>,<baseline-job-sh2>' \
  --pair '<candidate-job-sh3>,<baseline-job-sh3>' \
  --pair '<candidate-job-sh4>,<baseline-job-sh4>' \
  --pair '<candidate-job-sh5>,<baseline-job-sh5>' \
  --pair '<candidate-job-sh6>,<baseline-job-sh6>' \
  --pair '<candidate-job-sh7>,<baseline-job-sh7>' \
  --output './output/golden-evidence-draft.json' \
  --review-sheet './output/golden-blind-review.json'
```

## 4. 剩余外部验收 B：六指标人工盲审

审片人只打开 `golden-blind-review.json` 中的随机 A/B 播放地址，不查看身份清单。每条 A/B 都必须播放到结尾，并对六项分别给出 1–5 整数分和必要备注：

1. 主体/角色一致性。
2. 场景与道具一致性。
3. 构图、镜头运动与分镜意图。
4. 动作连贯性与时序。
5. 可用性/瑕疵程度。
6. 环境音与动作音匹配度。

评分完成后：

```bash
npm run finalize:seedance-golden -- \
  --draft './output/golden-evidence-draft.json' \
  --review './output/golden-blind-review.json' \
  --output './output/golden-evidence-final.json' \
  --report './output/golden-verification-report.json'

npm run verify:seedance-golden -- \
  --manifest './output/golden-evidence-final.json' \
  --report './output/golden-verification-report-independent.json'
```

只有最后验证器返回通过，且每镜无明显退化，才能关闭 Seedance Golden 门禁。

## 5. 剩余外部验收 C：MiniMax 独立候选试听

当前项目 `voice_preview_reviews = 0`，因此不得把既有正式 TTS Asset 当作“独立试听已通过”。

当前权威样片的实际验收目标已经由 Story、角色绑定和真实目录只读核对：

| 验收对象 | 使用范围 | 当前声线 | Provider 绑定 | 当前验收状态 |
| --- | --- | --- | --- | --- |
| 项目旁白 | 6 条旁白 | `Chinese (Mandarin)_Kind-hearted_Elder`（花甲奶奶） | `minimax-speech` / `speech-2.8-hd` / revision `4` | Preview 已固化；缺完整播放决定 |
| 角色 `c_ali`（阿离） | 2 条角色台词 | `female-shaonv-jingpin`（少女音色-beta） | `minimax-speech` / `speech-2.8-hd` / revision `4` | Preview 已固化；缺完整播放决定 |

2026-07-16 已刷新真实 MiniMax 目录（303 条音色）并对上述两个目标执行无确认 HTTP 预检：两次均返回精确的 `PAID_CONFIRMATION_REQUIRED`，分别绑定 `project.narrator.voice.preview` 与 `character.voice.preview`；预检前后项目总 `generation_jobs` 均为 `193`，`createdJobs = 0`，未调用 TTS。短期确认能力未保存，正式操作必须在 UI 重新预检。

同日用户确认后，两条独立 Preview 已真实生成、持久化并在服务重启后验证可恢复：

- 项目旁白 Job `061b9233-48c6-4398-9eb2-47818bc3c443` → Asset
  `ec79cd95-4001-48a6-ae80-3fddd61d5c80`，MP3，`7.344s`，checksum
  `24a5e1a92aece35530f57f2705659ba3c2b6a9e97d807ccbf7bb3c3b30f98fb0`。
- 阿离 Job `91962856-5b64-42eb-a1a8-330829d776f3` → Asset
  `0e33e6e6-8c69-477f-8883-8c50e043be27`，MP3，`2.268s`，checksum
  `90b5a256f6d1b7b729ca813d1acc2b83272c20f9bf49ef10d59fac305652c12e`。
- 两个受控 Asset 均通过 HTTP `200`、`audio/mpeg`、字节范围与长度校验。仍必须由用户完整播放到结尾并提交批准/淘汰决定，系统不会代填人工验收。

验收入口位于“角色与场景准备”顶部的 **MVP 声线试听验收**：直接点击“立即验收”展开受控音频，无需再进入选角详情。页面采集浏览器实际 `played` 区间；从中间或尾部跳播不会解锁验收。提交时服务端还会复核区间从起点连续覆盖受控 Asset 的实测全长，并把 `html-media-played-v1` 证据与决定一起固化。提交后点击卡片的“刷新”即可看到当前 Project/Story 的权威分子。

schema v19 之前仅凭 `ended` 写入的记录会投影为 `legacy-ended-v1`，只保留不可变审计历史，不再算当前批准。本机另一项目过去显示的 `2/2` 属于这种旧证据，升级后必须重新完整试听；它本来也不属于目标项目 `jinxue-changan-ep03`，不可借用。

- 对本样片的项目级旁白声线以及每个有台词的角色，至少创建一个当前 Story/catalog/Provider revision 下的独立 Preview Job。
- Preview 属于付费 TTS，必须经过无计费预检和用户明确确认。
- 必须完整播放到结尾后才能批准或淘汰；淘汰必须写原因。
- 审计记录必须绑定 Preview Job、Asset/checksum、voice、Story/catalog/Provider revision。
- 试听确认只写不可变验收事实，不自动提交正式 TTS，也不自动替换已绑定声线。

## 6. 发行安装包的独立 P0 门禁

2026-07-16 用户要求当前执行暂不处理发行，因此本节保持显式延期，未运行或伪造 release receipt；
这不影响本机开发版继续验收，但也不代表可对外分发。

本机开发运行与源码 MVP 不被此项阻断，但“可对外分发的安装包”仍不得发布：仓库没有通过完整来源、哈希、编译配置、许可证、对应源码和 smoke receipt 审核的可再分发 FFmpeg 二进制包。

对外发布前必须让以下命令在 release 输入上真实通过，不得伪造 receipt：

```bash
npm run build:release
npm run verify:ffmpeg:release -- \
  --receipt dist/legal/FFmpeg/VERIFICATION_RECEIPT.json
```

## 7. 已通过的工程验收

- `npm run build`：通过。
- 目标项目权威状态核对：当前 r4 compact candidate `2/8`、历史 Provider candidate `6`、r4 baseline `0/8`；Golden 卡片已按当前 Provider 身份分开计数，不再把混合集合显示为 `8/8`。安全入口只打开预设，未自动运行预检或提交 Provider。
- Agent Plan 零计费诊断：连接测试固定读取 `/contents/generations/tasks?page_num=1&page_size=1&filter.model=doubao-seedance-2.0`，成功时将返回中的非负整数 `total` 显示为“当前模型可见任务 N 个”；2026-07-18 实际结果为 `10`。测试覆盖请求方法必须为 `GET`，防止诊断误创建计费任务。
- Agent Plan 状态语义：设置中心不再把上述只读成功笼统标成“已连接”，而显示“列表可用”；详情和测试反馈同时写明“本次未创建任务，也未验证视频创建额度”。真实生产构建已点击 Seedance 卡片并重新执行只读探针，确认任务数 `10`、黄色零计费说明、按钮可用且浏览器控制台为零错误。
- 声线决定顺序稳定性：同一 Preview 在同一毫秒内连续批准/淘汰时，服务端把 `reviewedAt` 严格推进至少 1ms，避免 UUID 排序偶然把旧决定投影为当前；不可变历史和 `SUPERSEDED` 语义不变。
- 真实浏览器（schema v19 构建）：切换到 `jinxue-changan-ep03` 后，Golden 卡片实际显示当前 Provider compact `2/8`、独立 baseline `0/8`、补位历史 candidate `6`；`S0-0/S0-1` 为“待 baseline”，`S0-2` 至 `S0-7` 为“缺 candidate”，baseline 入口保持禁用且页面控制台无错误。
- 真实浏览器（声线迁移）：另一项目旧 `legacy-ended-v1` 决定不再计入当前分子，卡片实际为 `0/2`；展开项目旁白后显示“历史决定：通过试听 · 旧播放证据，需重新完整试听”，两个决定按钮在重新完整播放前均禁用。随后已切回目标项目，旁白与阿离均显示“试听已就绪 · 待完整播放验收”，当前分子 `0/2`，控制台无错误。
- `npm run test:server`：2026-07-18 在 schema v19 播放证据迁移完成后通过，Server `703/703`。
- `npm run test:client`：2026-07-18 通过，Client `488/488`；覆盖 `audioLines` 严格响应、发布方式签名/失效、工作台安全默认、Agent Plan 只读状态语义，以及声线 Preview 的完整播放/跳播拒绝。
- `npm run build`：2026-07-18 通过（TypeScript、Vite、Server bundle、OpenCut 法务归档）；仅保留既有 bundle 体积警告。
- 真实浏览器：生产构建重启后加载当前 8 镜/3-of-3 三视图/持久 OpenCut 时间线；打开逐镜生成并选择“Seedance 同步台词试听”，界面权威显示“仅保存候选版本”，控制台无错误，未运行付费预检或 Provider POST。
- `python3 e2e/offline-browser.py`：通过。
- `python3 e2e/audio-first-browser.py`：通过，报告 `output/audio-first-e2e/report.json`。
- `python3 e2e/offline-browser-faults.py`：通过，覆盖刷新、取消和硬重启恢复。
- `python3 e2e/per-shot-visual-analysis-browser.py`：通过，证明单镜视觉 Job、批量歧义恢复和零 Seedance 提交。
- `python3 e2e/browser-performance-spike.py`：通过；45 秒、9:16，最大音画边界误差 `50 ms`，报告 `output/performance-spike/report.json`。
- `python3 e2e/dual-encoder-file-acceptance.py`：通过，报告 `output/playwright/dual-encoder/acceptance-report.json`。
- `/api/health`：生产服务 HTTP 200，SQLite schema `19`、数据库状态 `ok`、Worker 运行（并发 `4`）。
- 媒体断连安全：真实 HTTP 测试在 Asset 已打开、响应流尚未建立时主动中止客户端请求，并确认服务端 FileHandle 已关闭；Range、HEAD、完整读取及 QC 下载门禁回归继续通过。

## 8. 关闭 MVP 目标的判定

只有下列事实同时成立，才能将“实现 plan”标记为完成：

- [x] 真实音频优先的 8 镜生产、OpenCut 时间线、1080p 导出、7 项 QC、人工发行批准和受控下载。
- [x] 工程、故障恢复、性能、双编码与零计费 Golden inspect。
- [ ] 8 个独立、同控制变量 Seedance baseline。
- [ ] 八镜六指标随机 A/B 完整播放盲审并通过验证器。
- [ ] 项目旁白与有台词角色的当前独立声线 Preview 完整播放验收。
- [ ] 若交付对外安装包，合规 FFmpeg bundle/release receipt 必须真实通过。
