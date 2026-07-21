# Seedance 真实 Golden 验收

`npm run verify:seedance-golden -- --manifest <manifest.json> --report <new-report.json>` 用于验证计划 12.7 的真实 6–12 镜盲审 A/B。该命令只校验既有结果，不提交 Provider 请求，也不会生成或补写评分。

## 从当前权威数据准备盲审

不要手工复制 Job、Provider Task、Story revision、timing manifest 或 Asset checksum。先只读检查当前 SQLite 中可作为 Golden 证据的成功任务：

```bash
npm run prepare:seedance-golden -- \
  --inspect \
  --episode '<episode-id>'
```

`eligible` 只包含同时满足以下条件的结果：当前 Story revision、当前镜头绑定、当前逐句语音 Asset/timing manifest、成功且独立的 Seedance Job/Provider Task、ready 本地视频 Asset，以及输出视频与所有参考图的实际文件 SHA-256 均一致。旧 Story、旧 timing、缺少外部 Task、损坏/漂移字节会进入 `rejected`，不会自动降级采用。检查和准备过程的 Provider 提交数固定为 `0`。

为 6–12 个相同镜头分别准备 candidate 与 baseline 的独立真实 Job 后，创建身份清单和独立盲审表：

```bash
npm run prepare:seedance-golden -- \
  --episode '<episode-id>' \
  --name 'seedance-compact-v1-vs-long-prompt' \
  --axis prompt_strategy \
  --pair '<candidate-job-1>,<baseline-job-1>' \
  --pair '<candidate-job-2>,<baseline-job-2>' \
  --pair '<candidate-job-3>,<baseline-job-3>' \
  --pair '<candidate-job-4>,<baseline-job-4>' \
  --pair '<candidate-job-5>,<baseline-job-5>' \
  --pair '<candidate-job-6>,<baseline-job-6>' \
  --output './output/golden-evidence-draft.json' \
  --review-sheet './output/golden-blind-review.json'
```

- `golden-evidence-draft.json` 保存 candidate/baseline 身份及不可变证据，审片人不得打开或直接编辑；它故意使用 `playbackComplete: false` 与 `0` 分占位，不能提前通过验证器。
- `golden-blind-review.json` 只显示随机 A/B、当前本机 Asset 播放地址与评分表，不泄露 role、Job 或 Provider Task 身份。
- 审片人填写根级 `reviewerId`、`reviewedAt`，完整播放每条 A/B 后将 `playbackComplete` 改为 `true`，并填写六项 1–5 整数评分。

完成后由合并器校验 A/B Asset 身份、完整播放、评分范围以及未被直接修改的证据草稿，再生成最终清单和报告：

```bash
npm run finalize:seedance-golden -- \
  --draft './output/golden-evidence-draft.json' \
  --review './output/golden-blind-review.json' \
  --output './output/golden-manifest.json' \
  --report './output/golden-report.json'
```

合并器会保留真实“未通过”结果：质量不满足非劣性门槛时仍写出完整清单和失败报告并返回非零退出码，不会删除证据或伪装成功。所有输出均使用 `wx`，不会覆盖既有验收档案。

## 硬性边界

- 每个清单只能比较一个轴：Prompt、参考图、时间戳指令、分辨率、音频策略或生成模式。
- 必须包含 6–12 个不重复镜头，每镜恰好有一个 candidate 和一个 baseline，并同时使用盲审标签 A/B。
- 每个结果必须绑定独立 Job、Provider Task、输出 Asset/checksum、当前 Story revision、不可变 timing manifest、Provider revision/model、请求参数和生成耗时。
- 除声明的比较轴外，模型、Provider revision、语音定时、时长等控制变量必须一致。
- 评分人必须完整播放每个结果后，按 1–5 整数记录角色一致性、动作遵循、运镜遵循、构图稳定性、可剪性和音频洁净度。
- 验证器同时检查平均非劣性、candidate 最低分和单镜最大退化；不能用平均分掩盖某一镜明显退化。
- Provider 没有可验证账单时，费用必须写成 `null` 且证据为 `unavailable`，不得估算或伪造金额。
- 报告使用 `wx` 创建，已有文件不会被覆盖；历史报告应与输入清单一起归档。

## 清单结构

清单根字段固定为：

```text
version, name, episodeId, comparisonAxis, createdAt, policy, cases
```

每个 variant 固定记录：

```text
盲审身份
Job / Provider Task / 输出 Asset 与 SHA-256
Story revision / timing manifest fingerprint
Provider / revision / model
时长 / 分辨率 / 音频策略 / 生成模式
Prompt compiler / Prompt SHA-256
参考策略 / 参考输入 fingerprint / 是否含时间码
耗时 / 可验证成本
人工完整播放确认、六项整数评分和备注
```

清单不保存 API Key、临时下载 URL、完整 Prompt、原著正文或未脱敏 Provider 错误。
