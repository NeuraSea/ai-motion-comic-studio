export const locales = ['zh', 'en'] as const
export type Locale = (typeof locales)[number]

export function isLocale(value: string): value is Locale {
  return locales.includes(value as Locale)
}

const content = {
  zh: {
    nav: { product: '产品', workflow: '工作流', architecture: '架构', login: '体验工作台' },
    hero: {
      eyebrow: '真实 AIGC 生产线 · 音频优先 · 可审计',
      titleLead: '把故事，变成',
      titleAccent: '会呼吸的漫剧。',
      description: '从原著知识、角色资产、剧本配音，到逐镜视频与 OpenCut 成片——让 Agent 处理复杂度，让创作者保留决定权。',
      primary: '进入体验工作台',
      secondary: '查看生产流程',
      proof: ['角色跨镜一致', '音画自动对齐', '全资产版本化'],
      frameTitle: '《烬雪长安》· 第 1 集',
      frameMeta: '8 镜 · 44 秒 · 角色声线已固化',
    },
    manifesto: {
      kicker: '不是演示壳。是真实生产系统。',
      title: '把不可控的生成，变成可恢复的制作。',
      body: '每一次模型调用都绑定剧本修订、Provider 版本、素材 checksum 与幂等任务；每一个画面、声音和剪辑决定都有历史。',
    },
    features: [
      ['01', '智能拆剧本', '从小说到场景、镜头、对白与导演意图，结构化结果可继续编辑。'],
      ['02', '角色一致性', '项目级角色资产、三视图与镜头引用分离，锁定身份而不锁死构图。'],
      ['03', '音频优先', '台词和旁白先确定真实时长，再驱动视频生成与 OpenCut 剪辑点。'],
      ['04', 'Agentic 选镜', '视觉模型理解镜头语义，推荐首帧、多参考图和角色视角，人工最终确认。'],
      ['05', 'OpenCut 时间线', '剪辑原子操作、撤销重做、字幕与自动修复，最终全部落在可编辑时间线上。'],
      ['06', 'Provider 自由', '文本、图片、语音、视频均支持默认服务与 BYOK/BYOA，不把能力锁在单一模型。'],
    ],
    workflow: {
      kicker: 'AUDIO-FIRST PIPELINE',
      title: '一条从创意到成片的生产主线',
      steps: [
        ['01', '项目知识', '原著、世界观、事件线、人物关系'],
        ['02', '数字资产', '角色、场景、道具、声线与多版本'],
        ['03', '剧本与配音', '逐镜拆解、表演指导、音频定时'],
        ['04', '分镜与视频', '画面生成、参考决策、逐镜动态化'],
        ['05', '剪辑与成片', 'OpenCut、字幕、混音、导出与质检'],
      ],
    },
    trust: {
      title: '创作可以快，生产事实不能乱。',
      body: '稳定 Asset ID + 可切换版本、不可变修订、持久任务队列、服务重启恢复，以及付费调用前的显式确认。',
      stats: [['19', '数据库 Schema'], ['1,192', '自动化测试'], ['24 fps', '统一时间基准'], ['0', '隐式付费调用']],
    },
    cta: { eyebrow: 'READY TO DIRECT?', title: '下一部漫剧，从一个故事开始。', button: '使用体验账号进入', note: '体验环境使用隔离数据副本；媒体生成会调用真实 Provider，请仅创建必要任务。' },
    footer: 'NeuraSea · AI Motion Comic Studio',
  },
  en: {
    nav: { product: 'Product', workflow: 'Workflow', architecture: 'Architecture', login: 'Try the studio' },
    hero: {
      eyebrow: 'REAL AIGC PIPELINE · AUDIO FIRST · AUDITABLE',
      titleLead: 'Turn stories into',
      titleAccent: 'motion comics that breathe.',
      description: 'From story knowledge, characters and voice to shot-level video and an editable OpenCut timeline—agents handle complexity, creators keep control.',
      primary: 'Enter demo studio',
      secondary: 'Explore the workflow',
      proof: ['Character continuity', 'Audio-video alignment', 'Versioned assets'],
      frameTitle: 'Ashes over Chang’an · Episode 01',
      frameMeta: '8 shots · 44 sec · voices locked',
    },
    manifesto: {
      kicker: 'NOT A MOCKUP. A REAL PRODUCTION SYSTEM.',
      title: 'Turn unpredictable generations into recoverable production.',
      body: 'Every model call is pinned to a script revision, provider version, asset checksum and idempotent job. Every image, voice and edit keeps its history.',
    },
    features: [
      ['01', 'Agentic screenplay', 'Structure a novel into scenes, shots, dialogue and direction—then keep editing.'],
      ['02', 'Character continuity', 'Separate project-level identity assets from shot composition and reference decisions.'],
      ['03', 'Audio first', 'Generate dialogue and narration before video, then drive shot length and edit points from measured audio.'],
      ['04', 'Visual shot agent', 'A vision model recommends frames, references and character views; humans make the final call.'],
      ['05', 'OpenCut timeline', 'Atomic edits, undo/redo, captions and automatic repair all land on an editable timeline.'],
      ['06', 'Provider freedom', 'Text, image, speech and video support platform defaults plus BYOK/BYOA.'],
    ],
    workflow: {
      kicker: 'AUDIO-FIRST PIPELINE',
      title: 'One production path from story to master',
      steps: [
        ['01', 'Project knowledge', 'Source, world, events and relationships'],
        ['02', 'Digital assets', 'Characters, locations, props, voices and versions'],
        ['03', 'Script & speech', 'Shot breakdown, performance and audio timing'],
        ['04', 'Boards & video', 'Image generation, reference logic and motion'],
        ['05', 'Edit & master', 'OpenCut, captions, mix, export and QC'],
      ],
    },
    trust: {
      title: 'Create fast. Keep production facts exact.',
      body: 'Stable asset IDs with switchable versions, immutable revisions, durable queues, restart recovery and explicit confirmation before billable calls.',
      stats: [['19', 'Database schema'], ['1,192', 'Automated tests'], ['24 fps', 'Shared timebase'], ['0', 'Hidden paid calls']],
    },
    cta: { eyebrow: 'READY TO DIRECT?', title: 'Your next motion comic starts with a story.', button: 'Enter with demo account', note: 'The demo uses isolated data; media generation calls real providers, so create only necessary tasks.' },
    footer: 'NeuraSea · AI Motion Comic Studio',
  },
} as const

export function getContent(locale: Locale) {
  return content[locale]
}
