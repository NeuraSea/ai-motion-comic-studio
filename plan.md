# 漫剧生产平台：端到端真实 MVP 研发计划

> 状态：研发中；架构边界已锁定  
> 更新日期：2026-07-18  
> 目标版本：本机单用户「制作人完整版」MVP

### 当前实施快照（2026-07-18）

#### 信息架构校正：项目知识库、数字资产库、分集制作台三域分离

2026-07-15 根据真实制作反馈锁定以下产品边界；它纠正了早期把全局原著/资产管理压入某一集制作页的表述，但不删减单集制作门禁：

- **项目知识库是一级模块，不是制作步骤**：稳定维护原著、世界观、事件线、人物关系与角色设定，并形成不可变内容 revision。当前已提供项目级原著正文、结构化世界观条目、可排序事件线与确定性人物关系图；schema v17 以独立 knowledge head/历史隔离 Story、声线和资产锁定等通用审计修订，恢复只会复制目标知识快照形成新 head，不会回退单集制作或覆盖历史。
- **数字资产库是一级模块，不是某集临时目录**：统一管理图片、音频、视频、脚本、台词及其来源、授权、Provider 与版本谱系。剧本撤销、镜头排序或某次制作 Run 变化不得删除或隐藏已付费生成的素材；不兼容版本以“历史版本/需核验”继续可见。
- **素材身份采用两层模型**：稳定 `assetId` 表示项目级素材族；不可变 `assetVersionId` 表示某次生成、编辑、裁切或上传的版本。切换素材库默认版本不会静默改动已制作分集。
- **分集制作台只引用，不拥有素材**：每次制作固化 Asset Manifest，至少包含 `assetId + assetVersionId + checksum`，并同时固定内容 revision、角色声线 revision 与 Provider revision。OpenCut 时间线元素也引用该受控版本身份。
- **显式升级而非自动漂移**：素材发布新版本后，已有制作继续复现旧版本；用户选择升级时先展示受影响镜头、视频、字幕和 timeline，再创建可撤销的新制作修订。
- **历史素材恢复不调用 Provider**：若服务端证明实体稳定 ID、视觉语义 fingerprint、风格与画幅均未变化，可通过带 `If-Match`、`Idempotency-Key` 和不可变审计的 re-attestation/adoption 将历史版本纳入当前制作；语义变化时只读预览并要求人工选择或重新生成。

因此用户可见导航调整为：

```text
项目 Catalog（项目 → 剧集层级；原著 / 世界观 / 事件线 / 人物关系）
数字资产 Catalog（项目 → 剧集层级；图片 / 音频 / 视频 / 脚本 / 台词 / 版本）
分集制作台（原著选集与制作设定 → 角色与场景准备 → 拆剧本与配音 → 分镜与逐镜视频 → OpenCut 剪辑与成片）
```

三者通过不可变 revision 与 Asset Manifest 关联，不通过页面顺序或临时 React 状态耦合。

- 已完成：SQLite **schema v19**、项目/修订/媒体/任务/Provider/Keychain 底座、SSE、图片生成、不可变 Provider 配置、OpenCut 兼容时间线文档 API、ETag/`If-Match` 与时间线修订历史。持久 PipelineRun coordinator、五步内部步骤文档、创建/查询/列表/取消 API、Worker 事件推进、容量续跑和重启恢复已接通。v7/v8 加入 Agentic 自动剪辑审计链；v9/v10 加入 Episode-scoped Story revision、角色三视图引用槽与 Story revision 不可变保护；v11/v12 加入人工发行复验与幂等时间线恢复审计；v13 加入逐镜分镜图/视频人工选版审计；v14 加入与不可变时间线修订绑定、只能由可信 materialize/reconcile 签发的媒体权威回执；v15 加入稳定 Asset Handle、不可变版本成员和默认版本切换审计；v16 加入 Episode-scoped Production Asset Manifest 与不可变条目；v17 加入项目知识独立 head、不可变成员索引与严格类型隔离；v18 加入声线试听验收的不可变审计；v19 将浏览器实际 played 连续区间、媒体实测时长和证据版本固化进同一决定，并使旧 ended 布尔证据失效。前端生产数据已全部切到 `/api/v1`；旧 `/api/project` 固定返回 `410 LEGACY_API_REMOVED`。
- 已完成（schema v19 播放证据升级）：浏览器提交试听决定时必须携带 `html-media-played-v1` 证据；服务端严格验证 1–64 个有序连续区间从起点覆盖至受控 Asset 实测终点，且证据时长与媒体时长一致。跳播到尾部、物质间隙、错误 Asset 时长或旧 `legacy-ended-v1` 布尔记录都不能形成当前批准；旧记录仅保留不可变历史，必须重新完整试听。
- 已完成（Agent Plan 与豆包语音）：Seedance 设置中心已把 Agent Plan `/api/plan/v3`、方舟按量 `/api/v3` 和自定义 NewAPI 网关拆成显式模式；官方模式锁定各自模型集合，自定义模式才允许编辑 Base URL/模型。豆包语音 2.0 已作为独立 `doubao-speech` Adapter 接入官方 Agent Plan HTTP 接口，固定 `seed-tts-2.0` Resource ID，解析分块 NDJSON/Base64 音频并复用角色、项目旁白、试听、正式配音与持久 Asset 链。两个 Provider 的 Keychain revision 独立保存和探测，不会隐式共享或泄露 Key。Seedance Agent Plan 的非计费连接探针只读任务列表；成功状态不再笼统显示“已连接”，而显示“列表可用”，并同时明确“未创建任务、未验证视频创建额度”，防止把 Key/路由可用误判为套餐额度恢复。2026-07-18 真实浏览器已验证该标签、当前模型可见任务 `10` 个、零计费说明及零控制台错误。
- 已完成：分集与结构剧本 API、Codex Tools Responses / 自定义 OpenAI-compatible 文本 Provider、严格 Schema 校验、不可变剧本 revision 和下游 stale 传播。自有前端支持粘贴或本地读取 UTF-8 `.txt`/`.md`，并已接通场景、对白、镜头属性编辑以及镜头新增、删除、同场排序。
- 已完成（版本恢复与真实撤销/重做）：前端版本历史只读取当前 Episode 明确归属的不可变 revision；恢复、撤销与重做都以 `If-Match` 创建新的审计修订，并真实使下游分镜、视频、导出和 QC 过期，不覆盖历史记录。客户端只保存 revision 指针，不保存伪快照；请求跨项目/分集返回、未知提交结果和同源 ETag 冲突均按作用域重新读取权威 Story+Episode，不能把旧分集结果写入当前工作台。
- 已完成（全实体资产工作台、真实编辑与三视图派生）：分镜图片任务固化 Scene/Shot/source revision，成功后原子回链 Shot 并保留版本链；前端覆盖结构剧本中的**全部角色、地点和道具**，可按实体生成、预览、锁定、执行真实 `images/edits` 与原生 `images/variations`。编辑任务强 ETag、跨刷新幂等、最多 4 张同实体参考图、Provider capability、版本族并发和付费确认全部 fail-closed，结果仍需人工审核后锁定。角色三视图支持在原图上人工确认正/侧/背归一化裁切框，由 bundled FFmpeg 零 Provider 调用派生三张不可变 PNG Asset；它不以 CSS 裁切或前端预览冒充资产。正/侧/背三张引用已支持 Episode ETag、同源谱系校验、单事务角色绑定、不可变审计修订和下游失效。逐镜图片以及未运行视觉分析的视频使用确定性非视觉安全规则选择本集锁定的正/侧/背参考槽，固化槽位 revision/checksum，并在付费媒体调用前再次校验；人工显式选择（包括明确清空）不会被 Agent 覆盖。
- 已完成（逐镜真实素材选版与恢复）：**分镜与逐镜视频**工作台 Inspector 可分别审阅当前镜头的分镜图和逐镜视频，候选只来自同项目、同 Episode、同镜头、同 source revision 的成功持久 Job 与 ready 本地 Asset，并使用真实图片/视频预览而不是 ID 冒充画面。人工采用、拒绝和恢复通过 Episode `If-Match` + `Idempotency-Key` 写入 v13 不可变审计；选版变化会精确使时间线、导出、QC 与 Pipeline 过期。分镜图 A→B 时，只有可证明完全独立于分镜图的纯文字视频可以保留，否则清除当前视频 pointer、精准取消同镜当前修订的活跃视频任务并保留历史视频 Asset；依赖旧分镜锚点的视频在旧图恢复前不可重新采用。采用后必须由已挂载的 OpenCut command state 执行权威 reconcile；v14 服务端会同时校验数据库指针和时间线实际渲染的 `mediaId`/同镜补尾 pin，普通保存不能伪造或继承回执。失败则持续阻断预览/导出，不允许仅刷新 UI 假装已同步。
- 已完成（逐镜角色视角判定、定向免费视觉 Agent 与人工恢复）：角色主图不再冒充正/侧/背三视图；当前 Episode 的 `character_visual_references` 槽位是角色视角的唯一权威来源。批量默认先运行不调用模型的确定性快速预检；只有单镜主动分析，或预检一次汇总出的歧义镜头，才允许用户显式创建免费的 `shot.video.reference.analyze` durable/idempotent Job，避免确定性镜头被整批深度分析拖慢。任务固化选镜范围、Story/source revision、受控图片 Asset version/checksum 与 vision-capable 文本 Provider revision；混合批次以分镜级 `referenceAnalysisJobId` 只让歧义镜头消费该持久结果，其余镜头继续走确定性规则。服务端重新验证项目、分集、镜头、修订、候选素材和输入指纹；客户端不能直接提交模型挑选出的 Asset 列表。视觉模型提交结果 unknown 时持久 fail-closed，系统不自动重提；界面可明确脱离仍在运行的免费 Job，改走快速推荐或人工确认，绝不把未完成结果送入付费预检。低置信度、证据矛盾或中近景角色槽位不足时必须展示真实缩略图要求人工确认；若角色为 0/3，界面提供“去项目数字资产库拆分 / 绑定三视图”或显式“纯文本”恢复。有效当前同镜分镜可作为首帧 fallback，绝不把下一镜自动当尾帧；失效或漂移会在 Seedance 计费前阻断。
- 已完成（配音执行与角色选角切片）：MiniMax `/v1/t2a_v2` 与自定义 OpenAI-compatible Speech Adapter 均已注册为持久 `dialogue.speech.generate` Job；TTS 与试听仍需付费确认，音频经时长探测后转存本地 Asset、回链 DialogueLine，并可逐句试听/重配。MiniMax 词级 sidecar 已支持安全下载、严格校验、元数据持久化和非敏感公开投影；不可用时明确记录句级 fallback。逐句 AI 导演和 AI 声线推荐属于免费的 LLM 文本理解：显式点击即创建 durable/idempotent Job，只产出待人工采用的建议，不自动提交 TTS。角色页已读取当前账号 `/v1/get_voice` 真实目录，支持搜索、手动绑定和由当前文本 Provider 执行的 Agentic 主选/备选/理由/场景表演指令；声线保存为独立不可变审计 revision，不替换 story source revision，单句合成默认原子继承角色绑定，临时覆盖只在高级入口。v18 建立试听批准/淘汰的不可变审计；v19 进一步要求服务端校验浏览器实际 `played` 区间连续覆盖媒体起点至终点，并与受控 Asset 实测时长一致。精确 Preview Job、音频 Asset/checksum、voice、Story/catalog/Provider revision、播放证据与决定一并固化；旧 `legacy-ended-v1` 记录只保留审计历史，不再算当前批准。此确认不调用 TTS、不会自动绑定声线，淘汰必须填写原因。2026-07-14 当前真实项目已有 8 条 MiniMax 语音 Asset 可发布并被一键生产零新增调用复用；独立候选试听的真实人工决定仍待用户完成。
- 已完成（当前声线验收目标零计费预检）：权威 8 镜样片实际需要 2 个独立 Preview 验收目标：6 条旁白使用项目级“花甲奶奶”，2 条角色台词使用阿离“少女音色-beta”。2026-07-16 已用当前 Episode ETag、303 条真实 MiniMax 目录 fingerprint、Provider revision 4 和各自固定 voiceId 分别取得 narrator/character 的付费确认挑战；前后 `generation_jobs` 均为 193，未创建 Job、未发送确认、未调用 TTS。正式 Preview 仍须用户重新预检并明确确认，成功后完整播放到结尾再写不可变批准/淘汰记录。
- 已完成（工作区分域、稳定素材身份与音频优先定时）：一级导航已把**项目 Catalog**、**数字资产 Catalog**与**分集制作台**分开；两个 Catalog 都以项目 → 剧集层级浏览，只管理长期内容和素材版本，不显示“待锁定”。制作台保留 **原著选集与制作设定 → 角色与场景准备 → 拆剧本与配音 → 分镜与逐镜视频 → OpenCut 剪辑与成片** 五个可见门禁；“锁定/本集引用”只存在于某一集的角色与场景准备。旧 `audio` 链接保留为“拆剧本与配音”的内部子页。文字生成、文本理解、逐句 AI 导演、AI 声线推荐、视觉判断以及全部 Agentic/多模态编排均属于对用户免费的 LLM 调用，显式点击后直接创建绑定 Provider revision 的持久幂等 Job；只有图片生成/编辑、TTS（含试听）与 Seedance 保留付费 preflight/confirm。schema v15 已把稳定 `assetId`、不可变 `assetVersionId`、族内 `versionNumber`、默认版本指针和切换审计落地；明确的图片编辑/变体、实体/分镜再生成、语音与逐镜视频会沿用原 handle，三视图派生保持独立素材，绝不根据复用语义不唯一的 `parentAssetId` 猜族。schema v16 已把 Production Asset Manifest、不可变 revision/entry、服务端重建、漂移检测与严格作用域校验落地；清单同时固定素材族 ID、精确版本 ID、checksum、内容/时间线/声线/Provider revision，Catalog 默认版本切换不会改写既有制作。
- 已完成（结构化项目知识 Catalog 与独立修订事实源）：项目 Catalog 不再只是四个大文本框；原著正文、世界观总纲与分类条目、可排序事件节点/参与人物、关系总纲与有向/双向人物关系边均可编辑，关系图由同一结构化数据确定性投影，不维护平行画布状态。schema v17 的 `project_knowledge_heads` / `project_knowledge_revisions` 不跟随历史兼容的 `projects.current_revision_id`，因此声线、Story、资产锁定等审计不会再把知识页切成错误快照；旧通用 revision 不会被猜测迁入知识域。保存与恢复均使用独立 ETag，恢复创建新 revision，未保存草稿会阻止恢复。
- 已完成（可调制作台布局）：主画布/镜头属性支持水平拖动分隔，制作区/OpenCut 时间线支持垂直拖动分隔；均有尺寸边界、键盘调整、双击复位和本机布局偏好持久化。属性栏与时间线原有收起/展开能力保留，收起不会丢失已调尺寸。
- 已完成（不可变 timing manifest 与同源字幕）：有台词/旁白的镜头必须先具备当前 source revision 下的完整语音 Asset。服务端将每条语音的 Asset ID/version/checksum/实测时长按 24fps **向外覆盖量化**后固化为 `ShotVideoDurationDecision`，同一决策同时进入 Seedance Job/Asset 和 `manjuTimeline.audioDrivenTiming` 哈希清单；不足一帧的尾音只允许补静音，不能因四舍五入被截断。Seedance 只接收 4–15 秒整数源片时长；短语音生成最短源片后由 OpenCut 精确裁切，超过 15 秒则阻断并要求拆镜，不变速、不截断语音、不借下一镜补时长。字幕从同一语音 Asset 的经校验词级时码原子物化到 OpenCut；无可靠 sidecar 时使用覆盖实测音频区间的整句 fallback，不伪造词级时间。
- 已完成（Seedance 安全生产切片与当前 8 镜音频优先候选集）：Seedance 2.0 BYOK、外部 Task ID 持久化、重启续查、临时 URL 安全下载、本地视频 Asset 落盘及自有镜头 UI 已接线。批量弹窗支持最多 24 镜、纯文字/首帧/严格首尾帧/多参考、480p–1080p 与三种声音策略；默认时长来自上述真实语音 timing manifest，手动时长不得短于语音。同一根 `Idempotency-Key` 绑定无计费 preflight→confirm，服务端固化 source/provider/Asset version/checksum，并对活跃任务、未知提交结果和并发漂移 fail-closed。Provider 可配置官方 Ark `/api/v3`、Agent Plan `/api/plan/v3` 或受信任 NewAPI HTTPS Base/模型；NewAPI 固定走 `/v1/videos`，付费 POST 后禁止路径 fallback。2026-07-15 当前 Story revision 已有 S0-0 至 S0-7 共 8 个 Seedance 1080p `sfx_only` 成功 Job；只读权威审计已逐项验证 timing manifest、独立外部 Task、输出/参考文件 SHA-256 与 Provider revision。它们尚无同控制变量 baseline，也未完成人工盲审，因此不能单独生成通过的 A/B Golden。Neurasea 网关仍未证明兼容。
- 已完成（Seedance 逐字台词试听与候选发布）：`provider_audio` 不再只是“让模型自由配音”。服务端从当前 Story 的 dialogue/narration 读取说话人和逐字文本，固化到视频生成 spec 与实际 Prompt，要求保留停顿和语气，并禁止 BGM、额外旁白与额外对白。批量工作台把“Seedance 同步台词试听”自动设为 `evaluation_only`：付费预检、确认 MAC、批次 fingerprint、Job 与 Asset 都固定该发布方式；成功结果只新增不可变视频候选，不改写 `shots.video_asset_id` 或当前 OpenCut 时间线，必须在真实素材选版中人工试听/审片后显式采纳。普通 `sfx_only`/`silent` compact 仍更新当前镜头，verbose A/B baseline 永远只能进入候选。客户端严格解析 `audioLines`，避免把合法台词 Job 当成损坏响应。2026-07-18 完整回归为 Server `703/703`、Client `488/488`，生产构建通过，并在真实工作台验证选择台词试听后显示“仅保存候选版本”。
- 已完成（集中声线试听验收与服务端完整播放门禁）：“角色与场景准备”的 MVP 验收卡可直接展开当前 Story/声线/Provider revision 下的项目旁白和有台词角色 Preview，原地播放并提交批准/淘汰，不再必须跳转到各自的选角卡。客户端采集浏览器 `played` 区间；服务端严格校验区间从起点连续覆盖到受控 Asset 实测尾帧、无物质间隙且时长一致，跳播到结尾、伪造布尔值或错误媒体时长都不能写入当前批准。决定和证据由服务端写入不可变审计，不调用 TTS、不替换已绑定声线。真实页面已验证受控 MP3 URL、展开状态、播放前按钮禁用和零控制台错误。人工决定严格按 Project/Story 隔离；其他项目旧的 `2/2` 只有 `legacy-ended-v1` 证据，升级 v19 后不再算当前批准，也不能充当目标项目的 `0/2`。
- 已完成（旧声线决定的可解释迁移 UX）：非当前记录不再统一误报为“历史绑定”。若服务端返回 `PLAYBACK_EVIDENCE_LEGACY`，界面明确显示“历史决定：… · 旧播放证据，需重新完整试听”，并保持批准/淘汰按钮禁用直到当前音频重新连续播放完毕；Story、Provider 或声线漂移则单独显示“绑定条件已变化”。真实旧审计项目已从历史 `2/2` 正确投影为当前 `0/2`，展开旁白记录验证文案、门禁与零控制台错误；目标项目仍为旁白+阿离 `0/2`，页面已留在可直接试听的验收入口。
- 已完成（声线决定严格追加顺序）：同一 Preview 的批准/淘汰若发生在同一系统毫秒，服务端会在事务内读取最新审计时间并把新 `reviewedAt` 单调推进至少 1ms；因此“最后一次决定”不再依赖随机 UUID 的字典序，旧决定仍以 `SUPERSEDED` 保持不可变历史。完整服务端回归覆盖同毫秒连续决定。
- 已完成（媒体断连句柄安全）：Asset 内容路由在客户端于 `openAsset` 的 realpath/stat/MIME 校验期间断连时，会立即关闭已经验证的 FileHandle；流式阶段同时在响应关闭时销毁源流，并以流 `close` 兜底关闭句柄、解绑监听。新增真实 HTTP 断连竞态测试直接断言文件描述符变为 `-1`，避免长时间音视频审片依赖 GC 回收句柄。
- 已完成（Seedance A/B baseline 可执行入口）：批量弹窗现提供默认 `seedance-compact-v1` 与验收专用 `seedance-verbose-baseline-v1` 两种受控 Prompt compiler。两者从同一服务端结构化镜头事实编译，verbose 策略只改变实际 Prompt；模型、Provider revision、参考图身份/顺序、音频 timing manifest、画幅、分辨率、声音策略及生成音频开关继续由同一权威预检固定。Prompt 策略进入批次 fingerprint、持久 Job spec、幂等租约与付费确认 MAC，不能拿 compact 的确认令牌创建 baseline。免费预检会逐镜展示实际 Prompt/compiler，且不创建 Provider Job；8 个 baseline 仍须用户明确确认付费后才能生成。
- 当前外部门禁（2026-07-18）：官方 Agent Plan Provider r4 / `doubao-seedance-2.0` 在权威 Story `84ef7e13-6212-4194-8670-914838536081` 下只有 `sh0`、`sh1` 两个 compact candidate 成功；其余六镜没有外部 Task ID。随后对缺失镜头执行的单镜逐字台词试听 `sh3` 在创建前被方舟明确拒绝为 HTTP 429 `QuotaExceeded`，未计入上游任务。2026-07-18 21:57 再次执行只读任务列表探针，Key、Agent Plan 列表路由与模型过滤均正常，当前模型可见任务仍为 `10` 个；这证明连接可用但不能证明创建额度恢复，且没有新 Task 或重复计费证据。当前 r4 candidate 为 `2/8`，baseline 为 `0/8`，不得用 r3 candidate 或另一 Story revision 的 r4 Job 拼接 Golden。恢复 Agent Plan 配额后仍必须重新免费预检并取得用户新的付费确认；系统不会自动用付费 POST 探测额度，也不会自动重提。
- 已完成（Prompt A/B Golden 身份收口）：Golden 准备器和独立验证器不再接受任意“长 Prompt”字符串冒充 baseline。`prompt_strategy` 轴现在逐镜强制 candidate=`seedance-compact-v1`、baseline=`seedance-verbose-baseline-v1`，并要求实际 Prompt checksum 不同；其余受控字段仍必须完全一致。错误 compiler、相同 Prompt、复用 Job/Provider Task/Asset 或控制变量漂移都会在人工盲审前 fail-closed。
- 已完成（OpenCut 命令/控制器桥与持久化）：固定 OpenCut Classic commit 的受控源码、许可证/来源校验，placement/snapping、移动/更新/切分命令、CommandManager、PlaybackManager，以及 Seek/Zoom/ElementInteraction/Resize controller 均已进入边界 workspace。漫剧自有 React 时间线已转发点击定位、缩放、拖拽/跨轨和双侧裁切事件；命令结果经 `ManjuStorageAdapter` 保存为 SQLite 不可变 revision。canonical v2 codec、v1 migration、materializer 和 export 已收敛到共享 parser。纯 `RenderSemanticPlan` 编译器进一步把 timeline/story revision、Asset version/SHA-256、24fps 画面裁剪/fit、音频 gain/fade/role/ducking 和字幕边界固化为深度冻结计划，并以 9:16 图片+视频混合边界签名做语义 golden；服务端 export adapter 已以唯一生产转换函数消费该 plan。基础预览可承载图片/可解码视频/音轨和 text 轨安全区字幕，但仍不是完整 compositor。
- 已完成（浏览器语义预览/审片快导与性能基线）：预览与快导共同消费打开弹窗时固化的同一 `TimelineDocumentSnapshot` 和 `RenderSemanticPlan`，支持连续图片/视频画面、cover/contain、视频裁剪、音频裁剪/增益/淡化/角色/显式对白 ducking 与不重叠字幕。45 秒、9:16、9 张图片+9 条本地语音+9 条字幕的真实 Chrome Spike 已完成，覆盖快导、取消、刷新恢复和服务重启恢复；720×1280 H.264/AAC 成片的最大音画边界误差为 50ms。同 snapshot 双编码文件级接受测试也已通过。另有一条从空项目开始的 6 镜音频优先浏览器验收：从 1,139 字原著生成 6 镜，在项目数字资产库完成两轮真实本地三视图派生/绑定，在“剧本与配音”生成 3 条旁白+3 条角色台词的不等长本地系统 TTS WAV，在“分镜与逐镜视频”只做 Seedance 零计费预检，再经 Agentic OpenCut 重排、同源字幕、1080p 正式 FFmpeg、7 项 QC 和受控下载闭环；刷新及 `SIGKILL` 后硬重启均可恢复。该测试使用确定性离线边界，不冒充真实付费 Provider 验收。当前真实 8 镜项目进一步以真实 MiniMax 音频、当前 timing manifest 和 8 个当前 Story revision 的 Seedance Asset 完成 OpenCut 混剪、1080p 正式导出、7 项 QC，并已写入完整播放后的不可变人工发行批准；它证明真实音频优先成片链可用，但不替代单控制变量 A/B Golden。完整 effect/mask/动画 compositor 仍未完成；目前只能宣称严格子集，包括已验证的 opacity fade、正向/反向矩形或椭圆硬边 mask，以及 RSP v5 的静态图片中心轻推近/轻拉远统一缩放。三者均由 OpenCut 时间线原子命令写入，并由 DOM 预览、Canvas 快导和 FFmpeg 正式导出消费同一 receipt。
- 已完成（未知 OpenCut 语义的浏览器保真拒绝与救援）：canonical 本身不兼容的 authoritative head 会在编辑前持久隔离，可下载完整 raw JSON 并从兼容不可变历史恢复；canonical 合法但超出当前 `RenderSemanticPlan` 审核子集的 element/effect/mask/动画，则在预览编译阶段显示结构化 `UNSUPPORTED_TIMELINE` code/path，禁止近似渲染，并提供绑定当前 timeline revision、ETag、Story revision、schema 与 upstream commit 的完整 JSON 复制/下载。救援 envelope 深拷贝保留未知 vendor 字段，打开/关闭预览不产生新时间线修订，也不调用任何 Provider。隔离 SQLite + 真实生产构建的 `test:e2e:recovery` 已覆盖“canonical 隔离 → raw JSON → 历史恢复 → render-unsupported effect 救援”全路径。
- 已完成（字幕与音频 MVP 切片）：BGM/SFX 安全上传与持久 Asset、音频库写入时间线、播放头自由文本字幕、音量/淡入/淡出命令已接线。materialize/reconcile 会从精确语音 Asset 时码自动创建绑定 scene/shot/line 的托管字幕，并以 OpenCut `ReplaceManagedSubtitleCueSetCommand` 原子写入；已存在的有效手工 cue 不会被覆盖，重复 reconcile 不会制造新 revision。自有逐词校订 UI 仍可编辑时码/文本、恢复供应商结果和整句 fallback。正式导出只消费时间线中已固化、来源可验证的 cue，不在导出时临时猜测字幕时码；自由文本与托管字幕可合并。
- 已完成（正式导出与发布门禁切片）：持久 `export.render`、不可变时间线快照、图片/视频混用 FFmpeg 渲染、字幕/音频混音、三种画幅和固定 H.264/AAC 规格已落地。片头标题、片尾落版与审片水印可固化为现有时长内的 ASS overlay，但不是完整片头片尾动画。持久 QC policy v2 真实检查可解码性、规格、黑帧、静音、峰值、字幕时序与字幕安全区共 7 项；旧 5 项报告不能授权发布。服务端对导出 `GET`/`HEAD`/Range 强制验证最新未过期的通过报告，通用 Asset 路由无法绕过。
- 已完成（FFmpeg 发行硬化切片）：`build:release` 生成绑定 manifest SHA-256 与完整 smoke 列表的 receipt；`start:release` 在端口监听前重验二进制、配方/许可证/对应源码哈希和 receipt，开发 `start` 不受影响。失败导出 Job 会在清理临时字节后持久限长脱敏 stderr、分类、无路径运行时审计摘要和不可变输入 pin。仓库仍没有可再分发的合规二进制，P0 安装包门禁仍关闭。
- 已完成（一键生产与付费确认）：服务端权威 preflight 统计真实已就绪/缺失/计费目标，并用 boot-scoped HMAC 绑定 source revision、调用意图、Provider revision/model 与素材状态。创建时任一绑定漂移都会在付费 Job 前失败；同配置活跃任务还有跨标签页去重门禁。内部五步现按 `speech → storyboard → timeline → export → quality` 执行：新的分镜子任务必须等待语音全部就绪，语音分支失败时不先消耗图片额度；历史 v1 Run 的已建子任务仍可恢复。前端使用漫剧自有视觉显示预检和五步进度，不引入 OpenCut 页面。
- 已完成（免费 LLM 直提与付费媒体确认分界）：剧本/文字生成、文本理解、逐句 AI 导演、AI 声线推荐、逐镜视觉判断及其他 Agentic/多模态编排不进入 PaidAigc 门禁；用户显式点击后直接创建 durable Job，服务端在串行 admission 中固化完整输入、Provider ID/model/config revision 与原始 `Idempotency-Key`，并拒绝不同键的活跃重复任务。图片生成/编辑、逐句 TTS、项目/角色试听与 Seedance 才采用 `free preflight → boot-scoped HMAC challenge → 显式确认 → durable Job` 的付费契约。两类任务都在执行前重验 source/目录/Asset/Provider 绑定；免费 LLM 的提交结果 unknown 时保留原键并 fail-closed，只允许精确读取/重放，绝不换键、跨 Provider 或自动重提。
- 已完成（Agentic 自动剪辑与 OpenCut 原子修复）：服务端从当前不可变时间线和 Story/Asset 事实源规划白名单 `UpdateElementsCommand` timing 操作，预览不接受客户端 document/operations，也不调用 Provider。黄色预览、确认后新修订、绿色变更证据、持久 application/plan ID 和“撤销为新修订”均已进入自有时间线 UI；Apply/Undo 使用 `If-Match`、幂等哈希、确认 capability、精确 candidate 对账和事务写入，后续手工编辑不会被撤销覆盖。一键生产也已复用同一 preview/apply 服务：materialize/reconcile、计划、应用与导出语义验证处在同一 SQLite 事务，PipelineRun 固化 plan/application ID；进程若在时间线提交后、Run 文档提交前中断，会从不可变 receipt 恢复而不是重复剪辑。候选还必须通过与正式导出相同的零计费 `RenderSemanticPlan` 语义门禁；视觉空隙/重叠、非托管音频或字幕越界等不能安全自动修复的情况会明确阻断，不能谎报“已可导出”。旧版把受控语音拉到镜头时长、导致 `trimStart + duration` 超过真实 Asset 的修订现可在 reconcile 时仅收缩不可能存在的尾部，并同步托管字幕。视觉序列只在精确匹配 Story 初始布局或已审计的音频驱动布局时才可自动重排；“连续无空隙”不再被当作服务端权威，避免覆盖用户主动裁短但仍连续的手工剪辑。
- 已完成（时间线历史恢复与冲突救援）：自有 OpenCut UI 可列出不可变 timeline revision，显示时间、摘要、轨道/元素、时长、Story 源、schema/commit 和父修订。恢复必须同 document/project/episode/source/schema/upstream，使用 `If-Match` + `Idempotency-Key` 复制为新子修订，不移动旧 head；恢复审计、新 head 与 export/QC/Pipeline stale 在同一 SQLite 事务。自动保存遇到 412 时保留完整本地 document，提供可复制/下载的救援 JSON、显式采用服务端 head，或在 pinned canonical 校验后基于最新 head 另存新修订；没有静默覆盖或客户端偽合并。
- 已完成（Agentic 智能运镜严格切片）：OpenCut 时间线新增先预览后应用的“智能运镜”。它只把剧本中唯一、非复合的推近/拉远指令（或缺失运镜时的保守近景/远景证据）映射为 RSP v4 已审核的静态图片中心统一缩放，并以一个 `commitElementPropertyUpdates` 原子命令写入可撤销、可持久化的新时间线修订。已有人工运镜、视频、同镜静帧补尾、横移/摇摄/环绕/跟拍/手持、推拉混合指令、未知动画通道和身份冲突全部 fail-closed；预览后的 duration/animation/hidden/绑定漂移会使整批失效，不会部分应用或把 plan 中任意数据直接写回。该动作不调用 AIGC Provider。
- 历史证据（不作为新音画验收）：2026-07-14 对既有失败 Run 的 `dialogue-s0-sh7-l7` 越界执行过 8 项 OpenCut 原子 timing 操作，并在零新增 AIGC 调用下完成 1080p/45 秒 MP4 与 7 项规格 QC。后续人工检查发现，旧的“全局对白重排”可能让语音滑入下一镜，规格 QC 也不能代替语义音画对齐验收。因此该成片只证明“零重复计费+可渲染+规格通过”，不证明新流程的逐镜音画同步；新 timing manifest 还需在真实 6–12 镜成片上进行人工复验。
- 当前真实项目技术证据（仍不替代 Seedance A/B golden）：2026-07-15 已在备份和隔离副本验收后，把当前 8 镜项目通过签名的 `managed-dialogue-reflow-v1` 安全计划固化为新 OpenCut 修订。结果为 1062 帧/44.25 秒、8 条语音不跨镜、8 条同源字幕、4 个短视频只用各自同镜锁定分镜补尾；随后生成 720p H.264/AAC 48kHz 成片并通过 7 项 QC。图片/语音/视频 Provider 调用数均未增加。随后真实项目再次暴露 `dialogue-s0-sh2-l2` 被旧修订拉长的问题：媒体实测 `5.544s`，旧片段 `750000 ticks`；reconcile 将它固化为 `670000 ticks`，签名 Agentic 计划以 19 个 OpenCut timing 操作同步 8 镜画面、8 条对白和 3 条既有字幕，后续 reconcile 已恢复为 8 条同源字幕，真实浏览器预览语义编译再次通过。此后按当前 revision/timing manifest 重新生成的 8 个 1080p `sfx_only` Seedance 结果已全部进入时间线修订 `2dba3bec`：8 个视频片段、8 条真实语音、8 条同源字幕，总计 1296 帧/54 秒。正式导出 `4328798f` 生成 Asset `b1342dea`，实际文件 31,073,475 bytes、SHA-256 `d7baa36c…731`，ffprobe 为 1920×1080 H.264/yuv420p/24fps + AAC 双声道 48kHz；QC `01247703` 七项全过，人工发行复验 `3e7be01e` 已明确批准三项语义 checklist，受控 `HEAD`/Range 下载门禁返回 200/206。旧 revision 的 10 个结果继续作为历史素材但不能充当 baseline。当前仍缺除比较轴外完全一致的独立 baseline 与逐镜六指标盲审。
- 当前真实项目参考图证据：角色视角绑定槽位实际为 0/3，已锁定的角色主图不会被错误当作三视图。2026-07-15 新生成的角色、场景、两个道具和三张本地三视图裁切共 7 个文件仍完整存在且 checksum 全部通过，但随后一次镜头顺序撤销把 Story head 从 `1171e100` 推进到 `84ef7e13`，旧前端因此错误隐藏了这些历史版本。工作台现改为历史版本始终可见、当前修订前只读；后端语义核验 adoption 完成前，不把这些旧 revision Asset 冒充当前锁定参考，也不发起视频 Provider 调用。
- 已完成（离线 HTTP + 浏览器 golden）：服务端 golden 覆盖预置合法 Story/6 镜/真 PNG/真 48kHz 音频、手动导出/QC、权威 Pipeline preflight、五步 PipelineRun、两次真 FFmpeg/7 项 QC、QC 字节门禁和两次 runtime 重启。完整离线浏览器 E2E 从新临时 SQLite/空原著编辑器出发，通过真实 HTTP、持久 Job、MediaStore、OpenCut adapter、FFmpeg、7 项 QC 和浏览器下载生成 30 秒 H.264/AAC MP4 并用 ffprobe 验证；测试边界使用确定性 Provider 且禁止外网，零付费调用。同一流程还验证 1024×600 Seedance 批量弹窗与无计费 preflight。
- 已完成（风格/画幅 412 并发冲突）：真实变更会事务性使下游过期但保留上传音频、配音和锁定实体引用；客户端以稳定 Episode→Story→Episode 权威束解决冲突，提供“重用本地意图”/“采用服务端”，并防止 ABA、重复点击和过期异步结果。
- 已完成（离线草稿与实体检索）：Story 编辑草稿按 Episode/source revision 作用域保存在本地，仅包含允许编辑的场景/镜头/对白字段；同 revision 可恢复，revision 漂移只允许复制救援文本或丢弃，不会覆盖服务器事实源。保存一个草稿后，其余已打开草稿会在服务端成功返回的新 revision 上安全重基，结构变更在存在未保存草稿时阻断。命令搜索已接通 SQLite 实体检索 API，覆盖场景、镜头、对白、角色、地点和道具，支持 ETag/revision 校验、取消过期请求、分页提示及精确聚焦。
- 已完成（短视频同镜补尾）：当 Seedance 成片短于 Story 剪辑点时，只允许使用同镜、同 revision、已锁定且 checksum 通过的分镜图补尾；视频不拉伸、不跨镜猜图，源音频随真实视频结束。修复计划经 OpenCut `UpdateElementsCommand` 原子应用后，时间线以分界线、绿色尾段与审计 hash 显示“同镜静帧补尾”，浏览器预览和 FFmpeg 导出共同消费同一显式 `shortVideoFill` 语义；未经 OpenCut 应用的待处理填充不能导出。
- 已完成（Seedance 人工 golden 证据门禁）：新增版本化清单验证器与默认测试入口，严格要求 6–12 镜、独立 Job/Provider Task/输出 checksum、当前 Story/timing manifest/Provider revision、单一 A/B 变量、完整播放确认及六项盲审整数评分；旧任务复用、控制变量漂移、缺失评分、平均非劣性失败和单镜明显退化均不能生成通过报告。验证器只核验既有事实，不调用 Provider、不生成评分，也不把未知费用伪造成估值。
- 待完成/验收：同控制变量 Seedance baseline 生成、逐镜六指标一致性盲审、MiniMax 独立候选试听验收及完整多参考 A/B Golden。当前 8 镜音频优先 candidate 已全部进入同一 OpenCut 时间线，并生成 54 秒 1080p H.264/AAC 48kHz 成片；7 项 QC 和用户“音画同步/字幕同步完整/角色画面语义”发行复验均已通过，因此不再把这条真实混剪的基础音画/字幕人工验收列为缺口。该发行复验不是逐镜六指标 A/B，不能替代真实付费 baseline 和盲审。权威候选检查、身份隔离清单、随机 A/B 盲审表、fail-closed 合并器与验证器已经就绪。**本机 MVP 的渲染边界锁定为已审核 strict subset**：opacity fade、正向/反向矩形或椭圆硬边 mask、静态图片中心统一缩放；完整多轨 effect/mask/动画 compositor 是后续版本范围，不再与当前 MVP 完成门槛混写。45 秒 Chrome 性能/音画 Spike、同 snapshot 双编码文件级对照、逐镜视觉分析/批量歧义恢复/多参考零计费预检，以及未知 OpenCut 语义的浏览器拒绝/救援 golden 均已自动化通过，不再列为待实现项。下一步的精确 Job/Asset 清单、付费安全顺序、六指标盲审命令、声线试听要求和 FFmpeg 发行门禁已固化在 `docs/final-acceptance-handoff.md`。
- 已完成（最终验收工作台入口）：分镜页新增只读的 Seedance Golden 卡片，严格按当前 Episode/Story revision 和当前可执行 `providerId + model + configRevision` 投影持久 `shot.video.generate` Job，逐镜区分 compact candidate、独立 verbose baseline、运行中与失败，不会把旧修订、历史 Provider 或生产 Asset 冒充 A/B。历史 Provider 的成功 candidate 单独显示为审计/恢复证据，不计入当前 Golden 分子。入口只打开安全预设：当前可用镜头全选、`1080p`、仅环境音/动作音、`seedance-verbose-baseline-v1`；仍必须先由用户运行免费预检，再单独明确确认计费，打开或重开绝不自动重提。当前权威样片应显示 r4 candidate `2/8`、历史 Provider candidate `6`、r4 baseline `0/8`，与 SQLite/Provider 证据一致。
- 已完成（Agent Plan Golden 身份漂移门禁）：当前视频 Provider 已切换到官方 Agent Plan `/api/plan/v3`、`doubao-seedance-2.0`、revision 4。既有历史 candidate 固定为旧 revision 3 / `doubao-seedance-2-0-260128`，不能与 r4 baseline 冒充单变量 A/B。Golden 卡片现逐镜读取 candidate 的 `providerId + model + configRevision`，只计入与当前可执行 Provider 完全相同的成功 Job；历史身份单独计数，不会把“r4 2 镜 + r3 6 镜”误显为 8/8。未补齐时禁用 baseline，并提供 8 镜全选、1080p、compact compiler 的“准备当前 Provider candidate”入口。r4 compact 与 verbose 已分别完成一次真实零计费 8 镜/59 秒 HTTP 预检，除 Prompt 字段外控制变量零漂移，未创建 Job 或调用 Provider。当前 r4 已成功 2 个 candidate；外部配额恢复后还需用户明确确认 6 个 r4 candidate，然后再确认 8 个 r4 baseline。
- 因此当前版本仍不是完整 MVP；任何尚未接线的按钮必须保持禁用并明确标注，不得用 Mock 冒充成功。

## 1. 目标与验收口径

把当前“真实文本/图片/配音/逐镜视频 + OpenCut 命令/基础预览/持久化 + FFmpeg 导出/QC”切片升级为知识、资产与制作分域且可统一验收的完整生产工具。新工作区不注入假项目，但仍有若干明确标为“待接入”的入口。用户最终应能在网页中完成：

```text
项目知识库：导入原著，维护世界观、事件线、人物关系与内容 revision
项目数字资产库：生成/上传/审核图片、音频、视频、脚本和台词版本
分集制作台：
  1. 选择 Catalog 中的项目/剧集内容 revision，确认本集制作设定
  2. 为本集明确引用角色、场景与道具的不可变资产版本
  3. 拆解/修订剧本，生成并确认真实对白/旁白音频
  4. 生成分镜图，以逐镜实测音频时长决定 Seedance 源片和 OpenCut 剪辑点
  5. 用 OpenCut 原子命令剪辑，固化同源字幕，导出、QC 并下载 MP4
```

模块/阶段切换只改变工作台路由，不自动调用 Provider。文字生成、文本理解、AI 导演/声线推荐、视觉判断及所有 Agentic/多模态编排均为对用户免费的 LLM 能力，用户显式点击即创建持久幂等 Job；只有图片生成/编辑、TTS（含试听）和 Seedance 要求付费 preflight/confirm。定时、字幕物化和 OpenCut 白名单操作本身不调用 AIGC Provider。

首个验收样片固定为：

- 30–60 秒，单集、1–2 个场景、6–12 个镜头。
- 最多 2 个主要角色；支持国风、日漫、3D 写实预设及自定义风格。
- 预览默认 720p；最终成片默认 1080p、24fps。
- 支持 16:9 与 9:16。
- 最终格式为 H.264、`yuv420p`、AAC 双声道 48kHz 的 MP4。
- 刷新网页、API 服务重启或 Provider 任务长时间运行时，项目和任务均可恢复。
- 所有可见按钮必须真实可用；未纳入范围的入口必须移除或明确标记为后续能力，不得继续展示假数据、假评分或假成功状态。

## 2. 已锁定的产品决策

### 2.1 交付形态

- 首发为本机单用户版本，不引入登录、多租户或云端协作。
- 数据模型支持本地多项目和 Project → Episode → Scene → Shot 层级；MVP 验收只要求单项目、单集。
- 动态漫模式必须在没有 Seedance Key 时也能完成真实 MP4 闭环。
- 配置 Seedance 后可启用逐镜 AI 视频模式；Seedance 视频与本地动态漫图片可以在同一时间线和正式导出中混用。

### 2.2 Provider 与鉴权

| 环节 | 默认 Provider | 自定义 Provider | 鉴权 |
| --- | --- | --- | --- |
| 文本 | Codex Tools `gpt-5.5` | OpenAI-compatible Text API | 默认 BYOA；自定义 BYOK |
| 图片 | Codex Tools `gpt-image-2` | OpenAI-compatible Images API | 默认 BYOA；自定义 BYOK |
| 视频 | 本地动态漫 + Seedance 2.0 | Seedance 官方 Ark 或兼容 NewAPI Base URL/模型 | Seedance BYOK |
| 配音 | MiniMax `speech-2.8-hd` | 注册式 TTS Adapter，首版支持 OpenAI-compatible Speech API | BYOK |

鉴权规则：

- BYOK：用户提供 Base URL、API Key 和模型名；密钥只保存到 macOS Keychain。
- BYOA：由 Provider 专属 Adapter 完成账号授权。首版只实现现有 Codex Tools 本地授权状态，不伪造“通用 OAuth”。
- 任意自定义 Provider 不允许填写自由格式 HTTP 模板；首版只接受经过校验的兼容协议和已注册 Adapter。Seedance 的 `/api/v3` Base 固定选择 Ark 原生协议，其余受信任 HTTPS Base 固定选择 NewAPI `/v1/videos`；任务提交后不得猜测路径或自动切换协议重提。
- 浏览器、项目 JSON、SQLite、任务输入输出和日志中均不得出现明文密钥或 OAuth Token。
- 每个任务固化 `providerId + model + providerConfigRevision`；运行中切换默认 Provider 不影响已提交任务。
- `provider_connection_versions` 保存每个 revision 的非敏感执行配置快照；BYOK Keychain account 也按 revision 版本化。轮换 Key/Base URL/Model 产生新 revision，旧凭据在仍有非终态任务引用时不得删除；健康检查、默认标记和启停 UI 状态不产生虚假配置 revision。
- 默认不跨 Provider 自动重试，防止重复计费。失败后由用户选择原 Provider 重试或换 Provider 重新生成。

### 2.3 明确不纳入本次 MVP

- 登录、团队协作、批注、权限、云同步、账单和算力余额。
- 精准口型/Viseme、数字人、声音克隆和 AI 音乐生成。
- 2K/4K、3 分钟以上剧集、批量多集生产和自动发布平台。
- “彻底解决人物一致性”等不可验证承诺；首版采用参考图约束、资产锁定和人工审核。

### 2.4 OpenCut 剪辑内核决策

- 产品视觉、信息架构、组件、文案和品牌全部保留漫剧工坊自己的实现，**不照搬 OpenCut UI，也不把公网页面 iframe 当成集成**。
- 自有组件的手势、快捷键、轨道约束、吸附、碰撞、裁切、切分和撤销/重做必须映射到 OpenCut 的 command/manager 语义；“保留自己的前端风格”不等于再维护一套平行剪辑规则。
- 剪辑领域逻辑采用 OpenCut Classic。当前已经直接复用时间线模型、placement/snapping、移动/更新/切分命令、CommandManager、PlaybackManager、Seek/Zoom/ElementInteraction/Resize controller，以及 `VideoCache`/`SceneExporter` 的 Mediabunny 生命周期；漫剧 React 只负责自有渲染和事件转发，命令保存走 SQLite adapter。严格 `RenderSemanticPlan` 子集已有 Canvas/WebCodecs 720p 审片快导，但完整 media/effect/mask/动画 compositor 仍是后续接线，不能把严格子集提前描述成全量能力。Classic 当前没有完成的转场库，MVP 不把其 “coming soon” 入口算作能力；先支持硬切和服务端明确实现的效果。
- OpenCut 新版主仓库当前仍处于从零重写阶段，官方把 Editor API、插件、Headless 和脚本列为未来能力，因此 MVP 不依赖尚未交付的接口。当前采用已可审计的 [OpenCut Classic](https://github.com/OpenCut-app/OpenCut-Classic)，固定基线 commit `cf5e79e919144200294fb9fed22a222592a0aeea`，不跟随归档仓库漂移。
- 2026-07-14 对 [OpenCut 主仓库](https://github.com/OpenCut-app/OpenCut) `main` HEAD `bab8af831b354a0b5a98a4a6e818ab7d633b94df` 的审计结果是：项目仍明确标注重写中，Editor API/Headless 尚属未来能力，`apps/api` 只有 `/`、`/health`、`/echo` 脚手架。这不是可直接复用的云端剪辑后端。
- OpenCut Classic 的剪辑工程主要使用浏览器 IndexedDB/OPFS，也不存在可直接替换本项目 Express/SQLite 的成熟剪辑后端。因此“后端复用”的可落地边界是：沿用 OpenCut 工程/轨道/命令的领域语义和文档契约，新增极薄的 `ManjuStorageAdapter` 与 SQLite/API 持久化层；不得把 Manju 持久化适配误称为 OpenCut 原生云后端，也不得同时维护另一套自研时间线规则。
- 受控源码提取只保留剪辑所需模块，记录上游 commit，并保留 OpenCut MIT LICENSE、版权声明和第三方依赖清单。所有 Manju 特有修改集中在 adapter、事件桥和主题接入层，便于新版 Editor API 稳定后替换。架构回归测试强制业务前端只能从 `@manju/opencut-editor` 公开边界导入，且该边界不得导入 React、Next 或任何样式文件，防止上游 UI/皮肤渗入自有视觉。
- 目标态中，OpenCut 浏览器渲染用于所见即所得预览和快速审片；可恢复、可 QC、规格固定的正式成片继续由持久 Worker 驱动服务端 FFmpeg。当前预览和 720p 审片快导已由一次 `flush()` 交接同一个精确 `timeline_document` revision，并共同消费严格 `RenderSemanticPlan`；该严格子集已通过与服务端 FFmpeg 的同 snapshot 语义黄金比对。完整 compositor 未完成，因此仍不能宣称超出严格子集的全量预览/成片一致性已验收。

## 3. 当前基线与迁移原则

当前真实能力已经从旧项目 JSON/图片内核迁移到 SQLite **schema v19**：包含独立项目知识 head/历史、项目与 Episode-scoped 不可变 Story 修订、稳定 Asset Handle 与不可变媒体版本、Production Asset Manifest revision/entry、通用 Job、可恢复 PipelineRun、逐镜素材选版审计、修订绑定的媒体权威回执、带服务端播放区间证据的声线试听验收审计、SSE、Provider BYOK/BYOA、结构剧本、角色朝向引用槽、时间线文档、Agentic 自动剪辑审计、导出和 QC。OpenCut command/manager 与 Seek/Zoom/ElementInteraction/Resize controller 已由自有 React UI 接线，命令结果通过 `ManjuStorageAdapter` 进入 SQLite；客户端、materializer、Manifest projector 与 export 共用 canonical v2 parser。BGM/SFX 上传、同源托管字幕、音频优先 timing manifest、音量/淡化/ducking、严格语义子集浏览器审片快导、导出文字 overlay、7 项 QC 字节硬门禁、Pipeline 权威付费预检和离线真 HTTP golden 已有代码闭环。45 秒 Chrome 性能/音画 Spike 与同 snapshot 双编码文件级对照已通过。当前真实 8 镜项目已经证明真实 MiniMax 音频优先 timing、当前 Seedance 多镜、OpenCut 混剪、1080p 导出、7 项 QC、完整播放人工发行批准与受控下载闭环；旧全局对白重排的历史成片不作为该证据。完整 compositor 不是当前 MVP 阻塞项；真实 Provider 侧尚缺的是同控制变量 baseline 与六指标盲审。

迁移时必须：

- 保留 `runtime/state.json`、现有成功任务和 `runtime/generated` 中的图片。
- 提供一次性导入，把旧项目和生成图片转成新 Project、Asset、Job 记录；导入成功后保留只读备份，不覆盖或删除原文件。
- `/api/project` 已退役并固定返回 410；前端只能通过 `/api/v1/projects`、episodes、story 与 timeline-document 读写生产数据。旧图片/任务兼容路由仅为迁移资产保留，不得重新引入项目快照写入。
- 不复用当前静态示例剧本、评分、时长和资产作为真实项目数据。

## 4. 技术架构

### 4.1 运行结构

- Web：继续使用 React + Vite，按生产阶段拆分页面状态和领域组件。
- Editor Core：`apps/opencut-editor` 是边界 workspace，`third_party/OpenCut-Classic` 保存固定 commit 的受控源码、LICENSE 与 provenance；根应用的自有 React 组件只通过公开 DTO/command contract 调用它，不导入 OpenCut 页面、样式、Zustand store 或浏览器存储。后续预览/渲染接线仍须保持同源、单启动命令，不增加用户手工维护的端口。
- API：继续使用 Express，负责项目、媒体、Provider 设置和任务控制。
- Worker：同一 Node 代码库中的独立持久任务执行器；本机启动时与 API 一起运行。
- 数据库：使用 Node 24 已验证可用的内置 `node:sqlite`，避免新增原生数据库依赖。
- 媒体：本地保存到 `runtime/media/<projectId>/<assetVersionId>.<ext>`；稳定 `assetId` 只作为数据库 handle，不直接冒充文件名。所有字节通过受控 Asset API 读取，不接受用户拼接任意文件路径。
- 合成：本机开发仍由 `ffmpeg-static` 与 `@ffprobe-installer/ffprobe` 驱动，持久 `export.render` Worker 消费不可变时间线 revision；同轨图片/视频混合、字幕烧录、BGM/SFX/对白混音、音量/淡化/ducking 和文字 overlay 已接线。QC policy v2 包含字幕时序/阅读速度和基于正式 ASS 参数的安全区检查；通过后的导出 `GET`/`HEAD`/Range 由服务端强制门禁。发行运行时和 `build:release` 已对显式/随包 FFmpeg 的来源、哈希、实际配置、法务材料、对应源码及所需能力失败关闭，但仓库尚无可再分发的合规二进制，安装包仍被 P0 门禁阻断。
- 状态推送：当前使用 SSE 推送 Job/Pipeline 状态。PipelineRun 与子 Job 均持久，Worker 终态事件非阻塞触发 coordinator 推进；页面刷新后通过 list/get API 恢复快照。

### 4.2 核心数据模型

- `projects`：标题、当前集、设置、当前 revision、创建/更新时间。
- `episodes`：目标时长、画幅、风格、状态。
- `revisions`：项目结构快照、变更摘要和父 revision，用于版本历史与恢复。
- `characters`、`locations`、`props`：故事设定、视觉描述、锁定 Asset 和版本。
- `scenes`、`shots`、`dialogue_lines`：剧本、镜头、对白、旁白、时长和时间线信息。
- `asset_handles`：项目级稳定 `assetId`、素材类型、素材库默认 `assetVersionId` 指针、handle revision 与时间戳；切换默认版本不改变 handle ID，也不重写制作 pin。
- `asset_handle_versions`：稳定 handle 与不可变 `media_assets.id` 的成员关系、权威族内 `versionNumber`、一次性封存的 checksum；旧 `media_assets.version` 不再被误当成跨版本族唯一序号。
- `asset_version_switches`：带 `If-Match`、`Idempotency-Key`、前后版本 ID、checksum 与 handle revision 的不可变切换审计；该操作不创建 Provider Job。
- `media_assets`：不可变 `assetVersionId`、类型、文件路径、MIME、尺寸/时长、校验和、来源、Provider、生成参数、source revision 与来源/派生 provenance。显式 handle 成员关系由 `asset_handle_versions` 承担；`parentAssetId` 不再被用来猜测版本族。
- `production_asset_manifests` / `production_asset_manifest_entries`（schema v16）：服务端从本集实体锁、三视图、分镜/视频、语音和 canonical OpenCut 时间线重建精确引用，按用途槽位固定 `assetId + assetVersionId + versionNumber + checksum`，并固化内容、项目、时间线、角色/旁白声线及 Provider revision。记录不可更新/直接删除，使用 Episode `If-Match` 与 `Idempotency-Key` 创建父子 revision；跨项目/剧集、未就绪、无 checksum 或不属于稳定素材族的引用一律阻断。
- `project_knowledge_heads` / `project_knowledge_revisions`（schema v17）：项目级知识使用独立 head 和不可变成员索引；只接受 `kind=project.knowledge`、schema v2 的严格结构化快照，保存/恢复不推进或读取通用项目审计 head。
- `voice_preview_reviews`（schema v18/v19）：v18 对已成功的角色/项目旁白试听保存批准或淘汰事实；v19 增加版本化 `playback_evidence_json`，要求连续 `played` 区间覆盖受控 Asset 实测全长。记录固定 Preview Job、音频 Asset/checksum、voice、Story/catalog/Provider revision 与播放证据，只追加、可幂等恢复，不创建 Provider Job，也不自动写入正式声线档案；旧 `legacy-ended-v1` 记录不再计为当前批准。
- `generation_jobs`：任务类型、状态、进度、资源、Provider、外部任务 ID、幂等键、重试链、错误和成本元数据。
- `pipeline_runs`：一次“一键生成”父任务、步骤依赖和总体完成度。
- `provider_connections`：只存非敏感配置和 Keychain 引用，不存凭据内容。
- `exports`、`quality_reports`：时间线快照、输出 Asset、规格和真实 QC 结果。
- `timeline_documents`：OpenCut 兼容工程文档、schema/upstream 版本、source revision、ETag、自动保存状态和更新时间；时间线元素通过扩展 metadata 稳定关联 Shot、DialogueLine 与 Asset。

所有生成资产不可原地覆盖；重生成产生新 Asset 版本。修改剧本、角色、场景、风格或镜头后，沿依赖图把下游分镜、视频、配音、预览和导出标记为 `stale`，禁止把旧产物误当成最新成片。

### 4.3 OpenCut 复用与适配边界

```text
漫剧工坊 UI（自有视觉/组件）
        ↓ 事件桥；不得复制领域算法
OpenCut Classic controller / command / document semantics
        ↓ CommandManager + PlaybackManager + Seek/Zoom/Drag/Resize（已接入）
        ↓ plain timeline snapshot
ManjuStorageAdapter（已接入的薄持久化适配层）
        ↓ timeline-document API
SQLite timeline_documents（已接入的事实来源）

AIGC Job / Asset API → MediaStore / JobWorker（已接入）

同一 flush 后的不可变 revision
        ├→ RenderSemanticPlan → PlaybackManager 语义预览（严格子集已接入）
        ├→ Canvas/WebCodecs + Mediabunny 720p 审片快导（严格子集已接入）
        └→ export.render → FFmpeg/ffprobe 图片/视频混合正式渲染（已接入）
                                      ↓
                         quality.check / quality_reports（已接入）
                                      ↓
                         服务端 QC 硬门禁后开放 GET/HEAD/Range（已接入）

完整 effect/mask/动画 compositor（待完成；opacity fade、正向/反向矩形或椭圆硬边 mask、静态图片中心统一缩放严格切片已验收）
```

实现约束：

- 上游受控提取位于 `third_party/OpenCut-Classic`，公开边界位于 `apps/opencut-editor`，并锁定 commit；业务组件不得复制粘贴其时间线算法后再分叉维护。不得把 Classic 的完整页面源码、CSS 和未使用依赖直接并入现有 Vite bundle。
- `ManjuStorageAdapter` 当前实现时间线加载、串行保存、`materialize`/`reconcile`、历史 revision 恢复、ETag 冲突保护和 `flush()`。父会话在打开预览/导出前取得并校验同一个精确 revision/ETag snapshot；消费者不得在弹窗内部再次 reconcile。完整 MediaResolver 已覆盖严格预览/导出子集，SQLite 中的 `timeline_documents` 仍是可恢复事实来源；浏览器存储只承载按 Episode/revision 作用域隔离的 Story 编辑草稿，不承载 Provider 密钥或权威素材状态。
- 自动保存使用 ETag/`If-Match`；冲突不得静默覆盖。服务端保存成功后才更新 dirty 状态。时间线 412 会保留完整本地 document，并只允许用户显式采用服务端 head，或在 canonical/source/schema/upstream 校验后基于最新 head 另存新 revision；无法安全另存时提供复制/下载救援 JSON。Story 草稿同 base revision 可恢复到编辑器；服务器 revision 已漂移时只提供复制救援文本或丢弃，绝不直接覆盖新 revision。
- AIGC 资产通过只读、受控 Asset URL/Blob 注入媒体解析层；不复制成匿名本地 File 后丢失 Asset ID。canonical v2 以 OpenCut 顶层 `mediaId`/audio `sourceType` 表达媒体身份，Manju 的 Shot、DialogueLine、assetVersion、sourceRevision 等绑定放在 namespaced metadata 中。客户端 codec、v1 migration、服务端 materializer 与 export 已共用该 parser；未知/冲突媒体语义会拒绝导出而不是静默降级。
- OpenCut 命令栈负责轨道编辑、吸附、切分、裁剪、移动与撤销重做；脚本/镜头变更通过 adapter 生成命令，禁止直接篡改 store。
- 时间线快照一经交给消费者即不可变。当前语义预览、浏览器快导和服务端 FFmpeg 已通过共享 `flush()` handoff 使用同一 snapshot ID；浏览器消费者在弹窗生命周期内只使用由该快照编译的同一个深度冻结 plan。后续编辑产生新文档 revision，不改变已打开预览或运行中的导出任务。
- MVP 首批开放图像、视频、对白/音乐/音效、文字/字幕轨；关键帧、mask、effect 只在上游能力通过回归测试后逐项开放。当前只额外开放已有跨渲染器契约的 opacity fade、单个矩形/椭圆硬边 mask（保留内部或反向保留外部），以及静态图片同步 `scaleX/scaleY` 的中心轻推近/轻拉远（4%/8%/12%）；视频缩放、feather/stroke/旋转/位移/非同步缩放/多 mask 等继续 fail-closed。
- 45 秒固定基线 Spike 已完成：9:16、9 张图片、9 条本地语音和 9 条字幕在 Chrome 中覆盖编辑、预览、取消、MP4 快导、刷新恢复与服务重启恢复，最大音画边界误差 50ms。扩展到 60 秒/12 镜与更低内存仍是优化目标，不是已验收事实。
- 上游新版只有在发布稳定 Editor API/Headless、完成工程迁移器和黄金样片像素/音频对比后才能切换，不能直接替换当前 Classic 受控提取。

### 4.4 通用任务状态机

```text
queued → running → waiting_provider → succeeded
           ↘ failed / cancelled
```

当前已实现的主要持久任务：

- `story.generate`
- `asset.image.generate`（实体候选和分镜均通过不可变 binding 区分）
- `asset.image.edit`（真实 edit / native variation）
- `asset.image.turnaround.derive`（本地 FFmpeg，零 Provider）
- `shot.video.generate`
- `dialogue.speech.generate`
- `export.render`
- `quality.check`

`asset.image.edit` 与零 Provider 的 `asset.image.turnaround.derive` 已是持久任务类型；独立 `timeline.preview.render` 仍是后续任务类型，当前基础预览直接读取已固化时间线 snapshot，不伪装成持久渲染任务。

任务要求：

- 创建接口必须接受幂等键；同一操作的重复提交不得重复扣费。
- Provider 429、超时和 5xx 进入可重试失败；鉴权、内容拒绝和非法参数默认不可自动重试。
- Seedance 保存外部 Task ID，服务重启后继续查询原任务。
- 各 Provider 独立配置并发和速率限制；图片任务继续保持安全的受控并发。
- 取消仅在 Provider 能力允许时生效；不能取消时明确告知用户，不伪装成功。

## 5. Provider 契约

### 5.1 文本 Provider

统一能力：

- `health()`、`listModels()`、`generateStructured()`、`cancel()`（若支持）。
- 输入包含模型、系统提示、用户原文、JSON Schema 和幂等信息。
- 输出必须通过本地 Schema 校验；失败只自动请求修复一次，仍失败则保留旧项目并展示原始错误摘要。

剧本结构最少包含：故事 Bible、人物、地点、道具、场景、镜头、对白/旁白、目标时长、画面提示词、运镜和转场建议。

### 5.2 图片 Provider

能力按 Provider 显式声明：`generate`、`edit`、`variations`、`multiReference`、支持的尺寸和格式。

- 角色三视图、场景图、道具图和分镜均进入统一 Asset/Job 体系。
- 锁定的角色/场景参考图作为后续图片生成输入；不能只依赖文字特征。
- 不支持多参考的 Provider 必须禁用对应功能并解释原因，不能静默退化。

### 5.3 视频 Provider

统一接口：`submit()`、`getStatus()`、`cancel()`、`capabilities()`。

Seedance 设置中心提供三种显式模式：Agent Plan 使用 `/api/plan/v3` 和套餐模型枚举；方舟按量计费使用 `/api/v3` 并允许填写日期版模型；自定义网关使用受信任 HTTPS Base 与 NewAPI `/v1/videos`。前两种走 Ark 原生接口，协议选择随不可变 Provider revision 固化，付费 POST 后不做路径 fallback。Agent Plan 连接测试只读取一页任务列表，不创建视频。服务端固化 Shot/Scene/Episode/source revision、Provider config revision 和所有参考 Asset 版本/checksum，保存外部 Task ID，轮询、重启续查、失败重试与本地停止；成功 URL 经 SSRF/重定向/DNS rebinding/250MB 上限校验后转存本地视频 Asset。Ark 取消只记录“请求已发送/任务未找到”等可证实状态；NewAPI 无取消路由时不发送伪 DELETE，仅停止本地轮询并警告上游任务可能继续计费。自有批量弹窗支持最多 24 镜、无计费 preflight、逐项费用风险确认、进度、错误、重试和预览。官方 Ark 单镜最低成本付费 smoke 已成功落盘并经 ffprobe 验证；6–12 镜批量人工 golden 仍未执行。

目标与当前限制：

- 每镜生成 4–15 秒视频，支持 480p、720p 和 1080p；常规验证默认 720p，单次最低成本 smoke 使用 480p。
- 当前 UI 已支持纯文字、首帧、严格首尾帧和多参考输入，以及最多 24 镜批量选择、权威 preflight 和费用确认。6–12 镜真实人工审核仍待真实 Provider 验收，不能只因 Stub 和协议测试通过就算作已完成。
- 图片优先用 Base64 或 Provider Asset；参考视频/音频需要公网 URL 或 Provider Asset 时再启用对象存储。
- 输出 URL 成功后立即下载并校验，不把临时 URL 作为永久 Asset。
- 默认关闭模型生成对白音频，避免与可控 TTS 冲突；环境声由独立音轨或用户素材提供。

官方参考：[Seedance 模型列表](https://www.volcengine.com/docs/82379/1330310#7571da3f)、[创建任务](https://www.volcengine.com/docs/82379/1520757)、[查询任务](https://www.volcengine.com/docs/82379/1521309)。

### 5.4 语音 Provider

豆包语音 2.0 Agent Plan 配置：

```text
Base URL: https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional
Model: doubao-seed-tts-2.0
Auth: X-Api-Key: <AGENT_PLAN_API_KEY>
Resource: X-Api-Resource-Id: seed-tts-2.0
```

- 作为独立 `doubao-speech` Provider 配置，不与 Seedance 配置记录隐式共用 Key；同一个 Agent Plan Key 若同时具备视频和语音权益，可以分别保存到两张 Provider 卡片的 macOS Keychain 槽位。
- HTTP MVP 真实解析分块 NDJSON/Base64 音频并固化本地 MP3 Asset；支持官方声线、情绪上下文、语速、音量和整数半音音高。
- 声线选择只来自官方 Speech 2.0 目录快照，任意文本不会被当作 `voice_type`。目录绑定仍固化 Provider revision 与 fingerprint，并适用角色/项目旁白的试听、人工确认和继承逻辑。
- 连接测试用保留的无效音色验证 Agent Plan 鉴权，不生成可发布音频；正式试听和 TTS 继续走付费确认门禁。

MiniMax 默认配置：

```text
海外版 Base URL: https://api.minimax.io
国内版 Base URL: https://api.minimaxi.com
Endpoint: POST /v1/t2a_v2
Model: speech-2.8-hd
Auth: Authorization: Bearer <MINIMAX_API_KEY>
```

- 每句对白按角色绑定的 voice ID 单独合成。
- `POST /v1/get_voice` 读取当前账号真实可用的系统、克隆和设计音色；用户不再手填不可发现的 `voice_id`。
- 角色声线作为角色档案上的独立不可变审计 revision 保存，固化 Provider revision、目录指纹、选择来源与更新时间；它不会替换分集的 story source revision，也不会使角色画面或视频失效。台词默认继承角色绑定，单句覆盖只放在高级入口。
- Agentic 选角只可从当前账号音色目录内选择，结合角色设定与实际出场场景给出主选、最多两个备选和可审计理由，不展示虚构分数。角色基础音色跨场景保持稳定，场景差异通过 emotion、speed、pitch 表演指令表达。
- 默认 `subtitle_enable=true`、`subtitle_type=word`、非流式输出。
- 保存无损或低损中间音频，合成阶段统一到 48kHz。
- MiniMax 返回词级时间戳 sidecar 时安全下载、校验并把 cue 元数据持久化；没有时间戳或 sidecar 不可用时，用 ffprobe 实测音频长度并明确记录句级 fallback，不伪造词级结果，也不因 sidecar 失败重复付费合成。
- 自定义 OpenAI-compatible Speech 走 `POST {baseUrl}/audio/speech`，当前支持 voice、speed、mp3/wav；MiniMax 专属情绪/音高/语言参数不会被静默转译。
- 支持角色级推荐/绑定、试听、重配单句、调整语速/音量/情绪和有审计记录的重新绑定声线。

官方参考：[MiniMax 同步语音合成 API](https://platform.minimax.io/docs/api-reference/speech-t2a-http)、[Get Voice](https://platform.minimax.io/docs/api-reference/voice-management-get)、[Voice Design](https://platform.minimax.io/docs/api-reference/voice-design-design)。

## 6. API 规划

新接口统一使用 `/api/v1`。截至 2026-07-15，已落地并有路由/契约测试的集合如下：

```text
GET/POST          /api/v1/projects
GET/PATCH         /api/v1/projects/:projectId
POST              /api/v1/projects/:projectId/import
GET               /api/v1/projects/:projectId/revisions
POST              /api/v1/projects/:projectId/revisions/:revisionId/restore

POST              /api/v1/projects/:projectId/episodes
GET/PATCH         /api/v1/episodes/:episodeId
GET               /api/v1/episodes/:episodeId/story
POST              /api/v1/episodes/:episodeId/story-generations
POST              /api/v1/episodes/:episodeId/story/revisions/:revisionId/restore
PATCH              /api/v1/scenes/:sceneId
POST              /api/v1/shots
PATCH/DELETE       /api/v1/shots/:shotId
POST              /api/v1/shots/reorder

GET               /api/v1/episodes/:episodeId/visual-asset-targets
POST              /api/v1/assets/image-generations
GET               /api/v1/projects/:projectId/asset-handles
GET               /api/v1/projects/:projectId/asset-handles/:assetId/versions
POST              /api/v1/projects/:projectId/asset-handles/:assetId/current-version
GET               /api/v1/episodes/:episodeId/visual-asset-history
POST              /api/v1/assets/:assetVersionId/adopt-current-visual-revision
POST              /api/v1/assets/:assetVersionId/lock
GET               /api/v1/assets
GET               /api/v1/assets/:assetVersionId
GET               /api/v1/assets/:assetVersionId/content
POST              /api/v1/dialogue-lines/:lineId/speech-generations
POST              /api/v1/shots/:shotId/video-generations
POST              /api/v1/assets/uploads/audio

GET/PUT            /api/v1/episodes/:episodeId/timeline-document
POST               /api/v1/episodes/:episodeId/timeline-document/materialize
POST               /api/v1/episodes/:episodeId/timeline-document/reconcile
POST               /api/v1/episodes/:episodeId/timeline-document/auto-edit/preview
POST               /api/v1/episodes/:episodeId/timeline-document/auto-edit/apply
POST               /api/v1/timeline-edit-applications/:applicationId/undo
GET                /api/v1/timeline-documents/:documentId/revisions
POST               /api/v1/episodes/:episodeId/timeline-document/revisions/:revisionId/restore

POST              /api/v1/episodes/:episodeId/exports
GET               /api/v1/exports/:exportId
GET/HEAD          /api/v1/exports/:exportId/download
POST              /api/v1/exports/:exportId/quality-checks
GET               /api/v1/quality-reports/:reportId

GET               /api/v1/jobs
GET               /api/v1/jobs/:jobId
POST              /api/v1/jobs/:jobId/retry
POST              /api/v1/jobs/:jobId/cancel
GET               /api/v1/events?projectId=:projectId

GET               /api/v1/providers
PUT/DELETE         /api/v1/providers/:providerId/credentials
POST              /api/v1/providers/:providerId/test
POST              /api/v1/providers/:providerId/auth/start

POST              /api/v1/episodes/:episodeId/pipeline-runs/preflight
POST              /api/v1/episodes/:episodeId/pipeline-runs
GET               /api/v1/pipeline-runs?projectId=:projectId&episodeId=:episodeId
GET               /api/v1/pipeline-runs/:pipelineRunId
POST              /api/v1/pipeline-runs/:pipelineRunId/cancel
```

其中对白编辑复用 `PATCH /shots/:shotId` 的结构化 `dialogueLines` 更新；分镜和实体候选生成复用通用 `assets/image-generations`，由服务端固化目标实体/Shot/source revision。Seedance 使用专用逐镜创建路由，但查询、重试和取消仍复用通用 Job API。`POST /exports` 创建持久 FFmpeg Job，`POST /quality-checks` 创建持久真实 QC；导出页在报告通过后使用受控 download 路由。

以下早期规划接口已明确不进入本机 MVP，不能以空路由冒充实现：

```text
POST              /api/v1/episodes/:episodeId/preview-renders
GET               /api/v1/providers/:providerId/auth/callback
```

- `preview-renders` 被同一不可变 `TimelineDocumentSnapshot + RenderSemanticPlan` 的浏览器预览/审片快导替代；另建服务端预览 Job 会产生第二套渲染事实源。
- `auth/callback` 不适用于当前 BYOA：Codex Tools 账号授权由本机代理维护，漫剧平台只通过 `auth/start`/连接测试实时读取外部授权存在性，不接收、不复制、不持久化 OAuth code/token。BYOK Provider 继续只把密钥写入 macOS Keychain。

PipelineRun 保留 `storyboard`/`speech`/`timeline`/`export`/`quality` 五个兼容字段，但权威执行顺序已固定为 `speech → storyboard → timeline → export → quality`。对新 Run，语音子任务未全部成功前不创建新的分镜子任务；旧 Run 中已存在的分镜 Job 只恢复/查询，不为缺口先行建单。preflight 返回权威的已就绪/缺失/计费数量和已解析 Provider 修订，并签发 boot-scoped HMAC `confirmationToken`；create 将它与实时重算结果比对后才允许创建付费子 Job。调用方的 `Idempotency-Key` 在精确响应未知时必须保留；同配置活跃任务还会在服务端拒绝不同键的重复建单。

`.txt`/`.md` 先由浏览器执行 MIME、UTF-8、路径和大小校验，再由 `POST /projects/:projectId/import` 使用独立项目知识 ETag 写入不可变 source revision；服务端再次严格限制文件名、内容字段与大小，并保留世界观、事件线和人物关系等结构化字段。OpenCut PlaybackManager 语义预览和内存型浏览器审片快导直接消费已固化 snapshot，不创建 `preview-renders` Job；它们只覆盖严格 plan 子集。45 秒真实 Chrome Spike 和双编码文件级对照已落地，但完整 compositor 仍未完成。QC policy v2 的解码/规格/黑帧/静音/峰值/字幕时序/字幕安全区与服务端下载硬门禁已落地：`GET`/`HEAD`/Range 都验证最新未过期报告，`export.video` 不能从通用 Asset content 路由绕过。完整发行审核仍待补齐。

> 2026-07-15 审计更正：不可变人工发行复验、浏览器 checklist 与受控下载黄金路径已经实现并通过自动化；当前真实项目也已对 export `4328798f-c153-4f40-a41f-4c22e12ccfc5`、QC `01247703-4c3d-402c-99c7-9e2168c0e971` 和 timeline revision `2dba3bec-dd14-4d64-846e-8d9f83904d24` 写入完整播放后三项均通过的不可变批准记录。上句“完整发行审核仍待补齐”仅保留为历史描述。

资源更新采用 revision/ETag 乐观锁，避免多个页面状态相互覆盖。媒体上传校验 MIME 魔数、文件大小和路径，远端下载沿用并扩展当前 SSRF、重定向、DNS rebinding 和下载上限保护。

## 7. 研发阶段与完成门槛

以下 M1–M6 是工程交付批次，不是用户工作台的页面顺序。用户界面遵循“项目知识库 / 项目数字资产库 / 三阶段分集制作台”的分域；M2 先持久化结构化内容底稿，数字资产库从该内容 revision 提取实体，分集制作再显式引用内容与素材版本。

### M1：持久化、任务与 Provider 底座

> 状态：已完成并自动化验证。项目/媒体/Job/Provider/SSE/Keychain、当前 schema v19（PipelineRun 自 v6 起持久化，逐镜素材选版审计自 v13 起持久化，媒体权威回执自 v14 起持久化，稳定素材身份与版本切换审计自 v15 起持久化，Production Asset Manifest 自 v16 起持久化，独立项目知识 head 自 v17 起持久化，声线试听验收审计自 v18 起持久化，实际播放区间证据自 v19 起强制持久并由服务端复核）、coordinator、权威 preflight、API 与自有视觉 UI 已落地；付费 Provider 的新增调用仍受显式预检与确认门禁约束。

- 完成 SQLite Schema、旧数据导入、媒体目录和安全 Asset API。
- 把图片专用队列升级为通用 Job Worker；Pipeline coordinator/API 自 schema v6 起持久化，当前统一运行在 schema v19。
- 完成 SSE、任务恢复、幂等、取消和重试。
- 完成 Provider 设置中心、Keychain、BYOK/BYOA 和连接测试。

完成门槛：现有图片能力迁移后不丢数据；重启服务后项目和任务状态一致；密钥不出现在 API 响应或日志。

### M2：原著与结构化制作底稿

> 状态：本地工程门槛已完成。粘贴原著、本地 `.txt`/`.md` 读取、分集配置、真实结构草稿生成、Schema 校验、revision、场景/对白/镜头编辑、镜头新增/删除/同场排序和 stale 传播已接通；前端版本历史、“恢复为新审计 revision”以及真实 revision 指针撤销/重做均已落地。SQLite 实体搜索和 Episode/revision-scoped Story 草稿恢复 UI 已完成，跨 revision 不会静默覆盖。离线浏览器 golden 已从空项目生成 6 镜合法底稿、完成人工修改并验证下游 stale；该底稿供项目数字资产库提取角色/场景实体，并由“剧本与配音”工作台确认正式剧本及生成真实语音。

- 支持粘贴、`.txt`、`.md` 导入和片名/时长/画幅/风格配置。
- 使用文本 Provider 生成严格结构化制作底稿；“剧本与配音”的人工修订与语音完成后才放行分镜/视频。
- 实现场景、镜头、对白编辑，搜索、撤销/重做和版本恢复。
- 移除示例评分，改成可验证的结构检查与时长检查。

完成门槛：从空项目生成 30–60 秒、1–2 场、6–12 镜的合法剧本；人工修改后正确触发下游 stale。

### M3：资产与制作人分镜台

> 状态：主体工作台与必需阶段门槛已完成。真实图片 Job、持久 Asset、分镜与精确 Shot/source revision 绑定、镜头增删/同场排序/属性保存，以及全角色/地点/道具的目标列表、候选任务、进度/失败/重试、预览、锁定与版本链均已接通。真实 `images/edits`、原生 `images/variations`、同实体多参考、跨刷新付费幂等、本地 FFmpeg 三视图派生以及三张朝向引用的原子绑定已接线。服务端已能按当前镜头视角推荐并固化正/侧/背引用，付费调用前复核槽位 revision/checksum。“分镜与逐镜视频”门槛现以全部真实分镜图就绪为动态漫必需条件，Seedance 保持可选增强，不再阻断无 Key 的本地 MP4 主流程。隔离浏览器 golden 已验证单镜免费视觉分析、批量歧义恢复、逐镜 Job 身份、刷新恢复与多参考 Seedance 零计费预检，且证明视频 Provider 提交数为 0；完整多参考的真实生成质量和一致性量化仍待用户授权付费 Provider 验收。

- 自动抽取角色、场景和道具并批量生成候选资产。
- 支持三视图、参考图编辑、候选对比、锁定、审核和单项重绘。
- 支持镜头增删、拖拽排序、景别、时长、运镜、转场、裁剪和提示词修改。
- 批量生成全部分镜，失败镜头可单独重试。

完成门槛：至少 1 个角色、1 个场景和全部镜头分镜均为真实文件，并使用锁定参考图生成。

### M4：MiniMax 配音与动态漫 MP4 闭环

> MVP 口径补充：本阶段以已审核的 strict subset 为完成边界；完整多轨 compositor 属于后续版本，不阻断本机动态漫 MVP。

> 状态：服务端动态漫闭环、基础剪辑/音频切片和完整离线浏览器黄金路径已完成。Pipeline 先生成真实语音；OpenCut materializer 再以当前 source revision 的实测语音 Asset 时长排布逐镜区间，并从同一 Asset 的可验证时码原子物化托管字幕。OpenCut Seek/Zoom/Drag/Resize controller 桥、command/PlaybackManager、SQLite revision 和共享 canonical snapshot 已落地；共享 `RenderSemanticPlan` 提供深度冻结的 24fps renderer-neutral 语义与边界签名。BGM/SFX 上传、音量/淡入/淡出和对白 ducking 会进入正式 FFmpeg 导出。离线 E2E 已从空编辑器生成、QC、下载并用 ffprobe 验证 30 秒 H.264/AAC MP4；45 秒 Chrome Spike 和严格子集的浏览器快导/FFmpeg 双编码对照已通过，完整 compositor 仍待验收。

- 集成 MiniMax TTS、角色声线绑定、逐句试听/重配和字幕时间戳。
- 引入锁定 commit 的 OpenCut Classic 剪辑内核并保留 MIT/版权声明；不引入其页面视觉、登录、项目列表或营销站代码。
- 用自有组件连接 OpenCut commands/managers，实现画面、对白、音乐、音效、字幕轨道，以及拖拽、吸附、裁剪、切分、排序、撤销/重做和播放头交互。
- 完成 `ManjuStorageAdapter`、`timeline_documents`、Asset MediaResolver、ETag 自动保存、明确的 preview/export snapshot handoff、断网草稿与 revision 恢复；移除 IndexedDB/OPFS 作为主存储的依赖。
- 支持授权 BGM/SFX 上传、音量、淡入淡出和对白 ducking。
- OpenCut Renderer 提供所见即所得预览/快速审片；服务端 FFmpeg 消费同一时间线 snapshot。当前已实现推拉、字幕、混音和现有时长内的片头标题/片尾落版/审片水印 overlay；专业动画片头片尾和完整转场仍属后续能力。
- 在网页播放并下载真实预览/成片。

完成门槛：不配置 Seedance 也能从空项目完成真实剪辑并导出满足规格的 MP4；刷新和服务重启后时间线可恢复；预览与正式成片的镜头顺序、裁剪点、字幕和音轨一致。

### M5：Seedance 逐镜视频

> 状态：安全批量执行切片、官方 Ark 单镜最低成本烟测、当前 8 镜音频优先 candidate 生成、OpenCut 混剪、正式导出/QC 与基础语义人工复验均已完成。Seedance Ark/NewAPI Adapter、Provider BYOK、同一幂等根键的无计费 preflight→confirm、最多 24 镜批量提交、纯文字/首帧/严格首尾帧/多参考、轮询、失败重试、外部 Task ID、服务重启恢复、临时 URL 安全下载和本地视频 Asset 落盘均已接通。新的音频驱动 preflight 将逐句语音 Asset 身份与时长固化为 `ShotVideoDurationDecision`，与 OpenCut 剪辑点共用；缺音频、手动时长短于语音或语音超过 15 秒都在计费前阻断。角色参考只来自当前 Episode 的真实三视图槽位；远景小剪影可形成可审计的不需要角色图决策，中近景歧义则显示三视图缩略图供人工恢复。有效同镜分镜可作为首帧 fallback，失效锚点和槽位漂移在 Provider 调用前阻断。短于剪辑点的视频只允许用同镜锁定分镜图补尾。只读候选审计和正式导出共同证明 8 个新 Job 均绑定当前 Story/语音 timing/Provider revision，且本地输出、参考字节、成片 checksum、7 项 QC 与受控下载一致。仍待的是同变量 baseline 和逐镜六指标 A/B 盲审，而非基础混剪链。

- 接入提交、查询、失败、过期和取消语义。
- 支持首帧、严格首尾帧、多参考三种合规输入策略。
- 支持单镜生成、批量生成、人工审核、局部替换和费用确认。
- Provider 任务重启恢复，结果立即转存本地 Asset。

完成门槛：6–12 个镜头可逐镜生成并与动态漫镜头混合，单镜失败不重做成功镜头。

### M6：制作人工具、QC 与发布候选

> 状态：本机发布工程门槛已完成。持久 `quality.check`/`quality_reports` 已真实执行可解码性、ffprobe 规格、黑帧、静音、峰值、字幕时序和字幕安全区检测，结果与导出 Asset checksum、时间线/剧本 revision 绑定。发布策略版本为 v2，旧 5 项报告不能继续授权。服务端对 `GET`/`HEAD`/Range 重新验证最新未过期报告，通用 Asset 路由不能绕过。浏览器黄金路径已证明先阻断发布、再由完整播放与三项语义 checklist 创建不可变人工复验、最后开放受控下载；当前真实 8 镜项目也已经创建与当前 export/QC/timeline/story 精确绑定的不可变批准记录。片头标题、片尾落版与审片水印可作为 export overlay，但不是完整动画包；专业动画包属于后续版本。

- 基于 OpenCut commands 完成搜索、撤销/重做、版本历史、镜头属性、裁剪和时间线细节；不另建平行剪辑状态机。
- 完成缺失素材、可解码性、分辨率、帧率、音轨、总时长、黑帧、静音、峰值、字幕时间和安全区检查。
- 导出配置真实控制画幅、分辨率、字幕、片头标题/片尾落版 overlay 和审片水印；不把 overlay 宣称为完整动画。
- 清理所有 Mock、禁用按钮和不可验证状态。

完成门槛：黄金路径、故障路径和重启恢复测试全部通过，生成的 MP4 可在浏览器和系统播放器播放。

## 8. 测试与验收

### 8.1 自动化测试

当前仓库已有：结构化项目知识/独立 head/历史恢复、结构剧本/依赖失效、Episode-scoped 版本恢复与真实撤销/重做、API/ETag/跨刷新幂等、任务与 Worker、schema v19（含 v6 PipelineRun、v7/v8 Agentic 自动剪辑审计、v9/v10 Story/角色引用约束、v11 人工发行复验、v12 幂等时间线恢复审计、v13 逐镜素材选版审计、v14 修订绑定媒体权威回执、v15 稳定 Asset Handle/版本切换审计、v16 Production Asset Manifest、v17 项目知识隔离、v18 声线试听验收审计与 v19 实际播放区间证据）、coordinator/preflight、Provider/Keychain、真实图片 edit/variation、本地三视图 FFmpeg 派生、逐镜视角分类/人工缩略图恢复/effective-anchor 漂移门禁、MiniMax/Seedance Stub 与重启恢复、媒体安全、OpenCut command/PlaybackManager/Seek/Zoom/ElementInteraction/Resize React 桥、原子 managed subtitle cue-set、canonical codec v1→v2 及服务端共享 parser、时间线 materialize/reconcile/auto-edit preview/apply/undo/history/restore 与冲突救援、BGM/SFX 上传与混音、淡化/ducking、导出文字 overlay、图片/视频混合 FFmpeg、7 项真实 QC 与服务端字节门禁。全离线真 HTTP golden 覆盖预置合法 Story 的 6 镜时间线、手动导出/QC 门禁、权威 Pipeline preflight、五步编排、两次真 FFmpeg 3 秒 MP4、两次 7 项真 QC、`GET`/`HEAD`/Range 与两次 runtime 重启恢复。完整离线浏览器 E2E 还从新 SQLite 和空原著编辑器出发，经真实 HTTP/Job/MediaStore/OpenCut adapter/FFmpeg/QC/下载得到 30 秒 H.264/AAC MP4，并覆盖窄屏 Seedance 6 镜批量弹窗与无计费 preflight；音频优先浏览器 golden 另覆盖真实本地三视图派生/绑定、“剧本与配音”修改导致旧引用 409、6 条不等长语音、6 镜免费预检、1080p 正式导出、7 项 QC、刷新和硬重启恢复。测试边界禁止外网和付费 Provider。测试数量不在计划中硬编码，仍以当次完整命令结果为准：

```bash
npm test
npm run build
npm run test:e2e:offline
npm run test:e2e:audio-first
npm run test:e2e:per-shot-visual
npm run test:e2e:offline:faults
npm run test:e2e:performance-spike
npm run test:e2e:dual-encoder
npm run test:seedance-golden-verifier
npm run prepare:seedance-golden -- --inspect --episode '<episode-id>'
```

仍须补齐或统一验收：

- Seedance 官方 Ark 单镜最低成本付费 smoke 与当前 8 镜音频优先批量/混剪/基础人工验收已通过；仍需同控制变量 baseline 和逐镜六指标 A/B 盲审。常规 Stub 已覆盖成功、上游失败、取消、重试和重启恢复。
- MVP strict subset 的 opacity fade、正向/反向单个矩形或椭圆硬边 mask、静态图片中心统一缩放跨渲染器契约已通过；未知 element/effect 的浏览器保真拒绝/救援 golden 也已纳入 `test:e2e:recovery`，验证完整 vendor 字段、revision/ETag pin、零 Provider 调用及零预览副作用。真实 MiniMax 结果开始的当前 8 镜音频优先链已完成 Seedance 多镜、OpenCut 混剪、1080p 导出、7 项 QC、完整播放人工批准与受控下载；仍需补齐的是同控制变量 baseline 和逐镜六指标 A/B 盲审。完整多轨 effect/mask/动画 compositor 是后续能力，不作为当前 MVP 阻塞项。
- 剪辑黄金比对：renderer-neutral `RenderSemanticPlan` 和 9:16 混合媒体边界签名已经锁定顺序、裁剪、fit、总时长、字幕 cue、gain/fade/role、ducking 与首/中/末帧统一缩放语义。同一 `TimelineDocumentSnapshot` 已分别经过浏览器快导的实际选帧/增益/缩放 helper、生产 `renderTimelineFromSemanticPlan` adapter 和 FFmpeg 参数生成器，自动化比对共享固定签名并验证字节 pin/SRT/滤镜图。允许编码像素差异，不允许语义时间线差异；完整 compositor 的扩展语义仍须逐项加入该契约。
- 浏览器故障路径：完整离线黄金路径、45 秒性能 Spike 已覆盖页面刷新、用户取消和运行中服务重启；真实项目也已经历旧 timing 越界并通过 reconcile/Agentic 计划恢复到当前 8 镜成片。仍需在后续真实 Provider 失败发生时验收其人工恢复体验，不能人为制造付费失败。
- 付费 Pipeline 已有常规离线 golden、并发/取消/重启测试、无 Seedance 动态漫路径、官方 Ark 单镜最低成本 smoke，以及当前 8 镜真实批量到成片的基础人工验收；下一次付费只用于单变量 baseline A/B，不再重复生成同一 candidate 集。
- 真实 Provider 烟测：由显式环境开关启用最短、最低成本任务；常规测试不调用付费 Provider。

### 8.2 黄金路径

1. 导入 500–1500 字中文故事，得到可编辑制作底稿。
2. 在项目数字资产库生成、审核并锁定至少一个角色三视图和一个场景图。
3. 在“剧本与配音”修改一个镜头和一句对白，保存 revision；随后先逐句生成真实音频。
4. 验证每镜的 timing manifest 绑定正确语音 Asset，并自动物化同源词级或整句 fallback 字幕。
5. 在“分镜与逐镜视频”生成全部分镜图并审核；再按各镜实测音频时长提交 Seedance 验证稿，失败镜头只重试自身。
6. 在“OpenCut 剪辑与成片”用 OpenCut 交互内核完成拖拽、裁剪、切分、字幕和音量调整，刷新后时间线不丢失。
7. 使用同一不可变 timeline snapshot 导出 MP4，确认语音不跨镜、字幕与语音同源、短源片只在本镜裁切/补尾。
8. 对最终 MP4 运行真实 QC；只有报告通过且人工音画语义复验完成后，才视为新流程验收通过。

### 8.3 故障路径

- 缺少 Provider 配置时阻止提交并指向设置页，不伪装成功。
- 文本模型返回非法 JSON 时自动修复一次，失败不覆盖现有剧本。
- 429、5xx 和超时进入可重试状态；成功镜头不重复生成。
- Seedance 执行中重启后继续查询同一外部任务。
- 修改剧本、风格或锁定资产后，相关下游产物自动过期。
- FFmpeg 或媒体损坏时保留中间产物和可诊断错误，不输出假成片。
- 删除项目或资产前检查引用，避免破坏仍被时间线使用的文件。
- OpenCut 自动保存遭遇陈旧 ETag 时保留双方 revision 并提示冲突，不能 last-write-wins。
- 上游文档含未知 element/effect 时保持原数据并阻止破坏性保存，不能静默丢字段。

## 9. 发布与运维底线

- `/health/live` 只检查进程；`/health/ready` 检查数据库、媒体目录、Worker 和必要 Provider 配置。
- 结构化日志至少包含 requestId、projectId、jobId、providerTaskId 和耗时，绝不记录密钥或完整用户原文。
- 临时 FFmpeg 文件任务结束即清理；未引用中间资产保留 7 天后才进入显式清理。清理默认只做 dry-run；apply 必须回传精确 `planFingerprint` 和 boot-scoped 确认令牌，并在隔离日志、`BEGIN IMMEDIATE` 引用复核和崩溃恢复下执行。被项目、任务、revision、时间线、导出或 QC 引用的资产不自动删除。
- 数据库迁移前已自动创建并验证 SQLite 物理快照，同时从该快照生成可独立读取、无密钥、带 SHA-256 的 `media-index-backups/*.json`。任一备份或索引验证失败都阻断迁移。
- 本机服务继续绑定 `127.0.0.1`，不默认暴露到局域网或公网。

## 10. 外部依赖与启动顺序

研发不等待外部 Key，可按 M1 → M2 → M3 → M4 先完成动态漫闭环。外部只需要：

```text
Seedance（设置中心写入 Keychain，三种模式显式选择）：
  Agent Plan / 方舟按量计费 / 兼容 NewAPI HTTPS Base URL + API Key
  Agent Plan model = doubao-seedance-2.0 | doubao-seedance-2.0-fast | doubao-seedance-2.0-mini

豆包语音 2.0（设置中心独立写入 Keychain）：
  Agent Plan 专属 API Key
  Resource ID = seed-tts-2.0
  model = doubao-seed-tts-2.0

MiniMax:
  MINIMAX_API_KEY
  model = speech-2.8-hd
```

密钥不得写入聊天、Git、前端、SQLite、日志或任何带真实值的 `.env` 文件；`.env.example` 只允许记录变量名和说明。接入时由用户在设置中心把真实凭据写入 macOS Keychain。拿到 MiniMax Key 后完成 M4 真实烟测，拿到 Seedance Key 后先执行无计费模型列表探测，再由用户显式授权最短、最低规格、单任务的 M5 付费 smoke；未知提交结果不得自动重提。

OpenCut 不需要采购 API。它以 MIT 源码依赖进入工程；发布物必须包含固定上游 commit、LICENSE、版权声明及第三方依赖许可。OpenCut 新版主仓库仅作为迁移观察目标，不作为 MVP 的运行时网络依赖。

当前 `ffmpeg-static` 的 macOS arm64 二进制报告为 `--enable-nonfree`，且配套 ffprobe 来自不同版本，只能用于本机内部 MVP 验证，不能原样进入可再分发安装包。运行时已优先选择带审计清单的显式或随包二进制，发行模式禁止回退；`npm run build:release` 会执行哈希/实际 version/config/source/license/corresponding-source 校验、所需 codec/filter 核对和真实编码/QC smoke。当前门禁会因缺少合规 bundle 正确失败；仍须按 `third_party/ffmpeg/BUILD.md` 从已验签的主来源和完整依赖源码构建各目标平台产物，并完成法务复核后才能解除 P0。

## 11. Definition of Done

MVP 只有同时满足以下条件才算完成：

- 项目 Catalog、数字资产 Catalog 以项目 → 剧集层级管理真实长期内容/资产；分集制作台的五个可见门禁都使用真实项目数据和真实产物。旧 `audio` 路由只是“拆剧本与配音”的内部子页，不冒充额外阶段。
- 任何含台词/旁白的逐镜视频均由当前 source revision 的真实语音 Asset 决定剪辑时长，timing manifest 可审计且与 OpenCut 时间线一致。
- 自动托管字幕必须来自同一语音 Asset 的可验证时码或完整音频区间 fallback；导出不临时伪造 cue。
- 动态漫和 Seedance 两条视频路径至少各完成一次真实端到端验收。
- 所有 Provider 均可连接测试、显示真实健康状态并正确处理未配置状态。
- 所有付费任务可追踪、可恢复、可局部重试，且不会因重复提交造成重复扣费。
- 最终 MP4 通过自动规格检查并能在浏览器播放和下载。
- 剪辑 UI 保持漫剧工坊视觉；轨道编辑、命令栈、吸附/裁剪/切分、预览渲染和快速导出来自固定版本 OpenCut 内核，且许可证归档完整。
- SQLite 时间线文档是事实来源；不存在只能在浏览器 IndexedDB 中找到的唯一工程数据。
- 刷新和服务重启不丢项目、任务、资产、版本或成片。
- 所有测试、TypeScript 构建和生产构建通过。
- 界面中不存在假评分、假余额、假进度、假导出或无说明的禁用按钮。

## 12. Seedance 逐镜生产策略与 Prompt 规范

本节把高强度生产经验转化为 M5 的产品与工程约束。核心原则不是堆砌“万能 Prompt”，而是明确不同输入模态的职责：**参考图表达谁、在哪里以及比例关系；文字只表达发生什么、镜头如何拍；对白、配乐和最终混音留在独立后期轨道。** 这些经验先作为默认生产配置，并通过真实 Provider 最低成本 A/B smoke 持续校准，不能固化为跨版本永远成立的模型事实。

### 12.1 分镜与生成请求的职责边界

- 分镜文档仍是导演决策、构图、景别、运镜和审核的事实来源；对含语音的镜头，剪辑时长事实来源改为不可变语音 Asset timing manifest。不把带表格、箭头、运镜曲线和说明文字的整张故事板直接提交给 Seedance。
- 系统从结构化分镜与 timing manifest 中提取单镜所需的最小输入：主体引用、场景引用、景别、运镜、主要动作、声音策略、Provider 源片时长、OpenCut 剪辑时长和输出规格。
- 时间戳保留在数据库和 OpenCut 时间线中；请求通过 Provider 支持的 `duration` 等结构化参数控制时长，不在 Prompt 中生成 `[0-3 秒]` 等伪精确标记。
- MVP 默认一次请求只生成一个镜头。多镜头连续生成仅作为后续高级模式；确需表达多镜头时使用“镜头 01、镜头 02”描述顺序，而不是依赖时间戳分段。
- 人负责故事、节奏和镜头意图，系统负责 Provider 适配、Prompt 编译、任务调度、版本管理和后期组装。

### 12.2 Seedance 结构化请求与 Prompt Compiler

新增 Provider 无关的 `VideoGenerationSpec`，至少包含：

```text
subjectRefs[]     已锁定角色/主体资产及 revision
sceneRef          场景或构图锚点资产及 revision
shotSize          景别
cameraMovement    运镜
action            当前镜头唯一主要事件或动作
audioPolicy       sfx_only | silent | provider_audio
duration          来自真实语音 timing manifest 的 Provider 整数源片时长；无台词镜头才使用剧本时长
resolution        默认 720p 验证稿
aspectRatio       项目画幅
sourceRevision    分镜、角色、场景和风格的组合 revision
```

- Prompt Compiler 将上述字段编译为 Seedance 的简洁请求，默认采用“主体、场景、声音、镜头”四段式，而不是让文本模型生成长篇提示词。
- 已由参考图表达的服装、五官、环境材质和构图信息不再用文字重复；文字重点描述主要动作、景别和运镜。
- 自动删除时间戳、重复外貌描述、无效情绪渲染和互相冲突的镜头指令，并限制单镜只包含一个主要叙事动作。
- 默认追加“仅生成与画面匹配的环境音和动作音，不生成背景音乐，不生成额外对白”；Provider 不支持音频控制时必须在能力注册表和 UI 中明确显示，不能假装生效。
- 高级用户可以查看和编辑编译后的 Prompt，但结构化字段始终作为可审计事实来源；保存请求时同时记录编译器版本、Provider、模型版本、参数、引用资产 revision 和最终 Prompt。
- BYOK 自定义 Provider 通过 capability registry 映射参考图数量、首尾帧、音频、分辨率和时长能力，不能假设即梦网页中的 `@主体` 语法可直接用于 API。

单镜默认编译结果示例：

```text
主体：阿离，使用已锁定角色参考图。
场景：参考秦岭断崖场景图，保持人物与断崖的比例。
镜头：远景，固定镜头。暮色中远处长安第一盏灯亮起，阿离站在断崖边，山中冷雾缓慢涌动。
声音：仅生成山风、衣料摆动和远处城市环境音，不生成背景音乐。
```

### 12.3 参考资产与一致性策略

- 角色三视图/主体图作为人物外观事实来源，场景图作为空间、色彩和尺度事实来源；生成请求必须绑定具体 Asset ID 与 revision。
- 可选生成“带主体比例的场景锚点图”，用于明确人物与环境的尺度关系；该图作为构图参考，不自动宣称能在所有模型版本中提高一致性。
- 场景图已经包含主体时，Provider Adapter 必须避免重复注入导致双人或重复主体；实际采用主体参考、场景参考还是合成锚点，由 capability registry 和验证结果决定。
- 修改角色、场景、画幅、视觉风格或镜头描述后，相关视频标记为过期，但保留旧版本和时间线剪辑点，禁止静默覆盖。

### 12.4 产品交互与费用安全

- 逐镜面板以结构化控件为主：主体、场景、镜头、动作、声音、分辨率和时长；原始 Prompt 放入可展开的高级区。
- 默认提供“720p 验证稿”配置，用于先审核构图、动作、角色一致性和声音，再锁定版本；1080p 或最终超分进入定稿阶段。
- 单镜和批量任务均遵循“只补齐缺失/失败项”的安全默认值；重生成已有结果必须二次确认并保留原资产版本。
- 每个真实任务显示费用风险、Provider、模型、分辨率、时长、外部 Task ID、真实状态和可用的中断入口。
- 中断是尽力而为：若 Provider 已接收非幂等请求，界面必须提示仍可能计费；结果不确定时保持 `PROVIDER_SUBMISSION_OUTCOME_UNKNOWN`，不能伪装取消成功或自动重复提交。
- 单镜失败只重试自身，不使已成功镜头回退；服务重启后继续追踪同一外部任务。

### 12.5 音频与 OpenCut 后期分层

- Seedance 默认只生成环境音和动作音；人物对白与旁白由已绑定的 MiniMax/IndexTTS2 Speech Provider 独立生成，BGM 使用授权素材或独立音乐 Provider。
- 对白/旁白是画面定时的前置产物：只有同一 source revision 下每条语音 Asset 都 ready 后，才能对含语音的镜头进行 Seedance 计费 preflight。
- 语音实测时长按 24fps 对齐为 OpenCut 剪辑点；Seedance 所需 4–15 秒整数 `duration` 仅是源片时长。源片过长可裁切，过短只用同镜锁定画面补尾，不通过音频或视频变速偷偷对齐。
- Provider 返回的视频原声进入独立 SFX/环境声轨，可单独静音、裁剪和调节音量，不能与对白或 BGM 烧死在不可编辑的混合轨中。
- Speech Provider 对白/旁白、Seedance SFX、BGM 和画面使用同一 canonical timeline snapshot，由 OpenCut 交互内核编辑并由正式 FFmpeg 导出混音。
- 默认执行对白 ducking，避免环境声和音乐遮盖对白；任何模型生成的意外 BGM 都必须可检测、可静音、可替换。

### 12.6 清晰度与定稿流水线

建议默认流程：

```text
生成并确认真实对白/旁白音频
→ 固化逐镜 timing manifest 与同源字幕
→ 720p 最低成本验证稿
→ 审核故事动作、构图、角色一致性和镜头可剪性
→ 仅重做失败或不合格镜头
→ 锁定镜头版本
→ 统一超分到目标交付分辨率
→ OpenCut/FFmpeg 正式合成与 QC
```

- “720p 对 Prompt 响应优于 1080p”当前仅作为经验假设，必须按 Seedance 模型版本分别验证；如果真实评测结论变化，通过 Provider 配置更新默认值，不修改历史任务。
- Topaz 可作为人工定稿工具参考，但 MVP 不能把本地商业软件当成无条件可用的服务端依赖；自动超分需另行选择具备 API、授权和成本可审计能力的 Provider。
- 超分结果作为派生 Asset 保存，关联原视频 checksum、超分模型/工具版本和参数，不能覆盖源视频。

### 12.7 真实 Provider 评测与完成门槛

用固定的 6–12 镜黄金集建立可重复 A/B，至少比较：

- 简洁结构化 Prompt 与长篇 LLM Prompt。
- 主体图 + 场景图与整张故事板输入。
- 无时间戳与带时间戳指令。
- 720p 与 1080p。
- `sfx_only` 与默认音频策略。
- 单镜逐次生成与多镜头连续生成。

每组记录角色一致性、动作遵循、运镜遵循、构图稳定性、可剪性、音频污染、生成耗时、失败率和实际费用。评测采用人工盲审加可自动化的媒体规格检查，不展示无法复现的“AI 评分”。

仓库已提供 `prepare:seedance-golden`、`finalize:seedance-golden` 与 `verify:seedance-golden` 三段式真实验收工具。准备器从只读 SQLite 自动核验当前 Story/timing manifest/Provider revision、独立 Job/Task/Asset、输出和参考图真实文件 SHA-256，并生成身份隔离的证据草稿与随机 A/B 盲审表；草稿使用 false/0 占位，不能提前通过。合并器只接受完成播放的六项 1–5 整数评分，并拒绝被直接编辑的身份清单或 A/B Asset 漂移。验证器要求 6–12 个不重复镜头，且除声明比较轴外的控制变量漂移、结果复用、旧 timing 证据、平均非劣性失败或单镜明显退化都会 fail-closed。Provider 没有可验证账单时费用必须明确为 unavailable，不能估算。2026-07-15 已对当前 Episode 执行零提交只读 inspect：8 个当前 Story/timing/Provider/本地字节均合格的 candidate，10 个旧 Story Job 被明确拒绝，`providerSubmissions = 0`。2026-07-16 用户确认后创建的 8 个 `evaluation_only` verbose baseline Job 均被方舟以 HTTP `403` / `AccountOverdueError` 明确拒绝，没有 Provider Task 或视频 Asset；已修正为 `PROVIDER_BILLING_UNAVAILABLE`，不会覆盖生产 Shot，也不会自动重提。恢复方舟计费状态后仍需重新免费预检并获得新的明确付费确认。完整格式与归档要求见 `docs/seedance-golden-evaluation.md`。

本节完成门槛：用户无需编写长 Prompt，即可从已锁定的主体、场景和分镜一键提交 720p 单镜验证稿；视频只携带可独立编辑的环境音/SFX；失败、重试、中断、重生成确认、版本保留和费用风险均真实可追踪；固定黄金集证明默认模板至少不劣于长 Prompt 基线，并可随 Provider 版本升级重新评测。

最终外部验收的可执行交接单见 `docs/final-acceptance-handoff.md`。项目旁白与阿离的两个 MiniMax Preview 已真实成功并固化为受控 MP3 Asset，服务重启后仍可访问，但完整播放与批准/淘汰决定仍须由用户完成；独立 Seedance baseline 因方舟账号欠费尚未产生。发行按用户要求暂缓。在独立 baseline、八镜六指标盲审与当前声线 Preview 完整播放验收真实完成前，本节不得标记为已通过。

本地运行可靠性已补充受管后台服务：`server:start/status/ensure/restart/stop` 使用原子进程状态、管理锁、PID 与入口命令双重校验、健康检查及持久日志。意外退出后 `server:ensure` 可恢复 5173；未知占用进程不会被终止。此能力只重启 Web/API 进程，不清理 SQLite、媒体 Asset 或 Job，解决开发验收期间反复出现的 `ERR_CONNECTION_REFUSED`，不改变上述付费 Seedance 与人工盲审门禁。

## 13. 2026-07-15 Seedance 参考图兼容性恢复

- 免费权威预检必须逐图校验 Seedance 输入包络，并返回镜头、角色、三视图槽位、Asset、实际尺寸与宽高比，禁止只显示无法定位的“参考图尺寸不符合”错误。
- 本次真实数据已定位为阿离背面槽位 `408×1024`，宽高比 `0.398`，低于 Seedance 严格下限 `0.4`；同源整张三视图 `1536×1024`、宽高比 `1.500`，符合输入要求。
- 角色正/侧/背槽位只负责内部视角判断、人工选择与不可变审计，不再作为 Agentic 默认的 Seedance 身份输入。服务端会验证槽位的本地派生谱系，并在付费预检前自动回溯为同源整张三视图；无法证明谱系时仍 fail-closed，不猜测父素材。
- 整张三视图不能替换本镜构图事实源：若当前分镜仍有效，默认请求按“当前分镜图在前、同源整张三视图在后”组成显式 `multi-reference`；二者都使用 `reference_image`，因为 Seedance 不允许 `first_frame` 与多参考模式混用。当前分镜负责内容与构图，整张三视图负责角色身份。多个槽位若来自同一张设定图会自动去重，避免被模型误解成多个角色。
- 手工兼容性恢复仍以镜头为作用域，不能静默修改角色全局锁定；它只用于旧素材缺少可验证谱系、整张三视图本身不合规或用户明确覆盖默认策略的情况。
- 未来本地三视图拆分统一使用 `ffmpeg-crop-seedance-safe-v2`：保留完整人物像素，必要时等比缩放并居中补白；例如 `408×1024` 安全派生为 `410×1024`，原 Asset 与历史版本保持不可变。
- 兼容性问题发生在免费预检阶段，不创建 Seedance 计费任务；只有恢复后再次预检通过，界面才展示显式付费确认。
- 浏览器真实流程已验证：S0-1 预检展示问题背面图与可用整张三视图，点击“本镜采用分镜 + 整张三视图”后同时预览两张真实图片，再次免费预检签名为多参考图并进入 `1` 个计费任务的确认门禁；验证期间未提交付费任务。自动路径另有服务端测试证明：背面槽位即使为不合规的 `408×1024`，只要同源整张三视图合法，Provider 固化输入即为“本镜分镜 + 整张三视图”，槽位图只保留在审计决策中。
