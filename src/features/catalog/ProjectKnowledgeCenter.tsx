import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpenText,
  Clock3,
  FileUp,
  GitBranch,
  History,
  LoaderCircle,
  Network,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react'

import {
  ApiError,
  getProjectKnowledgeSnapshot,
  importProjectSourceText,
  listProjectKnowledgeRevisions,
  restoreProjectKnowledgeRevision,
  updateProjectKnowledgeSnapshot,
} from '../../lib/api'
import type { ProjectKnowledgeSnapshot, ProjectRevision } from '../../lib/api-types'
import {
  WORLD_ENTRY_CATEGORIES,
  emptyProjectKnowledgeDocument,
  projectKnowledgeFromDocument,
  projectRelationshipGraph,
  sameProjectKnowledge,
  serializeProjectKnowledge,
  type ProjectKnowledgeDocument,
} from './project-knowledge-document'
import { readProjectSourceImport } from './project-source-import'
import './ProjectKnowledgeCenter.css'

type KnowledgeTab = 'source' | 'world' | 'events' | 'relationships'

const tabs: ReadonlyArray<{
  id: KnowledgeTab
  label: string
  icon: typeof BookOpenText
}> = [
  { id: 'source', label: '原著正文', icon: BookOpenText },
  { id: 'world', label: '世界观', icon: Sparkles },
  { id: 'events', label: '事件线', icon: GitBranch },
  { id: 'relationships', label: '人物关系图', icon: Network },
]

function knowledgeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function compactDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function validationError(document: ProjectKnowledgeDocument): string | null {
  const invalidWorld = document.worldEntries.find((entry) => !entry.title.trim() || !entry.detail.trim())
  if (invalidWorld) return '世界观条目必须同时填写标题和内容。'
  const invalidEvent = document.events.find((event) => !event.title.trim() || !event.summary.trim())
  if (invalidEvent) return '事件节点必须同时填写标题和事件内容。'
  const invalidRelationship = document.relationships.find((relationship) => (
    !relationship.source.trim()
    || !relationship.target.trim()
    || !relationship.label.trim()
    || relationship.source.trim() === relationship.target.trim()
  ))
  if (invalidRelationship) return '人物关系必须填写两个不同人物和关系名称。'
  return null
}

function RelationshipGraph({ document }: { document: ProjectKnowledgeDocument }) {
  const graph = useMemo(
    () => projectRelationshipGraph(document.relationships),
    [document.relationships],
  )
  if (graph.nodes.length === 0) {
    return (
      <div className="knowledge-graph-empty">
        <Network size={24} />
        <strong>尚未形成关系图</strong>
        <span>添加人物关系后，这里会生成确定性的项目级关系视图。</span>
      </div>
    )
  }
  return (
    <svg
      className="knowledge-relationship-graph"
      viewBox="0 0 640 360"
      role="img"
      aria-label={`人物关系图，共 ${graph.nodes.length} 个人物、${graph.edges.length} 条关系`}
    >
      <defs>
        <marker id="knowledge-arrow-end" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" />
        </marker>
        <marker id="knowledge-arrow-start" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto-start-reverse">
          <path d="M8,0 L0,4 L8,8 z" />
        </marker>
      </defs>
      {graph.edges.map((edge) => {
        const middleX = (edge.source.x + edge.target.x) / 2
        const middleY = (edge.source.y + edge.target.y) / 2
        return (
          <g key={edge.id} className="knowledge-graph-edge">
            <line
              x1={edge.source.x}
              y1={edge.source.y}
              x2={edge.target.x}
              y2={edge.target.y}
              markerEnd="url(#knowledge-arrow-end)"
              markerStart={edge.direction === 'mutual' ? 'url(#knowledge-arrow-start)' : undefined}
            />
            {edge.label && <text x={middleX} y={middleY - 7} textAnchor="middle">{edge.label}</text>}
          </g>
        )
      })}
      {graph.nodes.map((node) => (
        <g key={node.id} className="knowledge-graph-node" transform={`translate(${node.x} ${node.y})`}>
          <circle r="29" />
          <text textAnchor="middle" dominantBaseline="central">{node.label.slice(0, 7)}</text>
          <title>{node.label}</title>
        </g>
      ))}
    </svg>
  )
}

export function ProjectKnowledgeCenter({
  projectId,
  projectTitle,
  onSaved,
}: {
  projectId: string
  projectTitle: string
  onSaved?: (snapshot: ProjectKnowledgeSnapshot) => void
}) {
  const [snapshot, setSnapshot] = useState<ProjectKnowledgeSnapshot | null>(null)
  const [revisions, setRevisions] = useState<ProjectRevision[]>([])
  const [draft, setDraft] = useState<ProjectKnowledgeDocument>(emptyProjectKnowledgeDocument)
  const [activeTab, setActiveTab] = useState<KnowledgeTab>('source')
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'importing' | 'restoring' | 'error'>('loading')
  const [error, setError] = useState('')
  const [importNotice, setImportNotice] = useState('')
  const [restoreCandidate, setRestoreCandidate] = useState<ProjectRevision | null>(null)
  const scopeRun = useRef(0)
  const sourceFileInput = useRef<HTMLInputElement | null>(null)
  const baseline = useMemo(
    () => snapshot ? projectKnowledgeFromDocument(snapshot.document) : null,
    [snapshot],
  )
  const dirty = Boolean(baseline && !sameProjectKnowledge(baseline, draft))
  const graph = useMemo(() => projectRelationshipGraph(draft.relationships), [draft.relationships])
  const invalid = validationError(draft)

  const load = useCallback(async (signal?: AbortSignal) => {
    const run = ++scopeRun.current
    setState('loading')
    setError('')
    setImportNotice('')
    try {
      const [current, history] = await Promise.all([
        getProjectKnowledgeSnapshot(projectId, { signal }),
        listProjectKnowledgeRevisions(projectId, { signal }),
      ])
      if (run !== scopeRun.current) return
      setSnapshot(current)
      setDraft(projectKnowledgeFromDocument(current.document))
      setRevisions(history)
      setRestoreCandidate(null)
      setState('ready')
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'REQUEST_ABORTED') return
      if (run !== scopeRun.current) return
      setState('error')
      setError(caught instanceof Error ? caught.message : '无法读取项目知识库')
    }
  }, [projectId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const save = async () => {
    if (!snapshot || !dirty || state === 'saving' || invalid) return
    setState('saving')
    setError('')
    try {
      const result = await updateProjectKnowledgeSnapshot(
        projectId,
        serializeProjectKnowledge(draft),
        snapshot.etag,
        { summary: '更新项目原著、世界观、事件线与人物关系' },
      )
      setSnapshot(result)
      setDraft(projectKnowledgeFromDocument(result.document))
      setRevisions(await listProjectKnowledgeRevisions(projectId))
      setState('ready')
      onSaved?.(result)
    } catch (caught) {
      setState('error')
      setError(caught instanceof Error ? caught.message : '项目知识库保存失败')
    }
  }

  const restore = async () => {
    if (!snapshot || !restoreCandidate || dirty || state === 'restoring') return
    setState('restoring')
    setError('')
    try {
      const result = await restoreProjectKnowledgeRevision(
        projectId,
        restoreCandidate.id,
        snapshot.etag,
      )
      setSnapshot(result)
      setDraft(projectKnowledgeFromDocument(result.document))
      setRevisions(await listProjectKnowledgeRevisions(projectId))
      setRestoreCandidate(null)
      setState('ready')
      onSaved?.(result)
    } catch (caught) {
      setState('error')
      setError(caught instanceof Error ? caught.message : '项目知识修订恢复失败')
    }
  }

  const importSource = async (file: File | undefined) => {
    if (!file || !snapshot || dirty || state !== 'ready') return
    setState('importing')
    setError('')
    setImportNotice('')
    try {
      const input = await readProjectSourceImport(file)
      const result = await importProjectSourceText(projectId, input, snapshot.etag)
      setSnapshot(result)
      setDraft(projectKnowledgeFromDocument(result.document))
      setRevisions(await listProjectKnowledgeRevisions(projectId))
      setActiveTab('source')
      setImportNotice(`已从 ${input.fileName} 创建不可变项目知识修订；世界观、事件线与人物关系保持不变。`)
      setState('ready')
      onSaved?.(result)
    } catch (caught) {
      setState('error')
      setError(caught instanceof Error ? caught.message : '项目原著导入失败')
    } finally {
      if (sourceFileInput.current) sourceFileInput.current.value = ''
    }
  }

  const moveEvent = (index: number, delta: -1 | 1) => {
    setDraft((current) => {
      const nextIndex = index + delta
      if (nextIndex < 0 || nextIndex >= current.events.length) return current
      const events = [...current.events]
      const [moved] = events.splice(index, 1)
      if (!moved) return current
      events.splice(nextIndex, 0, moved)
      return { ...current, events }
    })
  }

  return (
    <section className="project-knowledge-center">
      <div className="knowledge-heading">
        <div>
          <small>PROJECT KNOWLEDGE · STRUCTURED CATALOG</small>
          <h2><BookOpenText size={20} /> {projectTitle}</h2>
          <p>这是项目级知识源，不隶属于任何单集。世界观、事件线与人物关系会和原著一起进入不可变项目修订；单集制作只引用明确版本。</p>
        </div>
        <button className="button primary" disabled={!dirty || Boolean(invalid) || state === 'saving' || state === 'restoring'} onClick={() => void save()}>
          {state === 'saving' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
          {state === 'saving' ? '保存中' : dirty ? '保存新修订' : '已保存'}
        </button>
      </div>

      {error && (
        <div className="knowledge-error">
          <AlertTriangle size={15} />
          <span>{error}。本地草稿仍保留，重新读取前请先确认是否需要复制。</span>
          <button type="button" onClick={() => void load()}>重新读取</button>
        </div>
      )}
      {invalid && <div className="knowledge-validation"><AlertTriangle size={14} /> {invalid}</div>}
      {importNotice && <div className="knowledge-import-notice"><FileUp size={14} /> {importNotice}</div>}
      {state === 'loading' ? (
        <div className="knowledge-loading"><LoaderCircle className="spin" size={20} /> 正在读取项目知识修订…</div>
      ) : (
        <>
          <nav className="knowledge-tabs" aria-label="项目知识类型">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const count = tab.id === 'world' ? draft.worldEntries.length
                : tab.id === 'events' ? draft.events.length
                  : tab.id === 'relationships' ? draft.relationships.length
                    : [...draft.sourceText].length
              return (
                <button key={tab.id} type="button" className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>
                  <Icon size={15} /><span>{tab.label}</span><b>{count}</b>
                </button>
              )
            })}
          </nav>

          {activeTab === 'source' && (
            <div className="knowledge-tab-panel knowledge-source-panel">
              <div className="knowledge-source-editor">
                <div className="knowledge-source-heading">
                  <span><BookOpenText size={15} /> 原著正文 / 故事母本</span>
                  <div>
                    <label className={`button secondary knowledge-source-import${dirty || state !== 'ready' ? ' disabled' : ''}`}>
                      {state === 'importing' ? <LoaderCircle className="spin" size={14} /> : <FileUp size={14} />}
                      {state === 'importing' ? '导入中' : '导入 .txt / .md'}
                      <input
                        ref={sourceFileInput}
                        type="file"
                        accept=".txt,.md,text/plain,text/markdown"
                        disabled={dirty || state !== 'ready'}
                        onChange={(event) => void importSource(event.target.files?.[0])}
                      />
                    </label>
                  </div>
                </div>
                <p className="knowledge-source-import-help">导入会立即创建新的项目级不可变修订，仅替换原著正文；不会覆盖结构化世界观、事件线、人物关系或任何单集制作数据。</p>
                <textarea
                  aria-label="原著正文 / 故事母本"
                  value={draft.sourceText}
                  onChange={(event) => setDraft((current) => ({ ...current, sourceText: event.target.value }))}
                  placeholder="粘贴完整原著、故事大纲或主线文本。"
                />
                <small>{[...draft.sourceText].length.toLocaleString('zh-CN')} 字符</small>
              </div>
            </div>
          )}

          {activeTab === 'world' && (
            <div className="knowledge-tab-panel">
              <label className="knowledge-overview-field">
                <span><Sparkles size={15} /> 世界观总纲</span>
                <textarea value={draft.worldbuilding} onChange={(event) => setDraft((current) => ({ ...current, worldbuilding: event.target.value }))} placeholder="用一段话定义时代、规则、冲突和视觉基调。" />
              </label>
              <div className="knowledge-section-heading">
                <div><strong>结构化设定条目</strong><small>规则、势力、地点、文化和视觉基调可独立维护</small></div>
                <button type="button" onClick={() => setDraft((current) => ({
                  ...current,
                  worldEntries: [...current.worldEntries, { id: knowledgeId('world'), category: 'rule', title: '', detail: '' }],
                }))}><Plus size={13} /> 添加条目</button>
              </div>
              <div className="knowledge-card-list">
                {draft.worldEntries.map((entry, index) => (
                  <article key={entry.id} className="knowledge-structured-card">
                    <header><span>设定 {index + 1}</span><button type="button" aria-label={`删除世界观条目 ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, worldEntries: current.worldEntries.filter((item) => item.id !== entry.id) }))}><Trash2 size={13} /></button></header>
                    <div className="knowledge-inline-fields">
                      <select value={entry.category} onChange={(event) => setDraft((current) => ({ ...current, worldEntries: current.worldEntries.map((item) => item.id === entry.id ? { ...item, category: event.target.value as typeof entry.category } : item) }))}>
                        {WORLD_ENTRY_CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                      </select>
                      <input value={entry.title} maxLength={120} placeholder="条目标题" onChange={(event) => setDraft((current) => ({ ...current, worldEntries: current.worldEntries.map((item) => item.id === entry.id ? { ...item, title: event.target.value } : item) }))} />
                    </div>
                    <textarea value={entry.detail} maxLength={4_000} placeholder="明确约束、例外与对剧情/视觉的影响" onChange={(event) => setDraft((current) => ({ ...current, worldEntries: current.worldEntries.map((item) => item.id === entry.id ? { ...item, detail: event.target.value } : item) }))} />
                  </article>
                ))}
                {draft.worldEntries.length === 0 && <div className="knowledge-structured-empty">尚无结构化设定；旧版总纲仍完整保留。</div>}
              </div>
            </div>
          )}

          {activeTab === 'events' && (
            <div className="knowledge-tab-panel">
              <label className="knowledge-overview-field">
                <span><GitBranch size={15} /> 事件线总纲</span>
                <textarea value={draft.eventLine} onChange={(event) => setDraft((current) => ({ ...current, eventLine: event.target.value }))} placeholder="记录全局时间尺度、主线因果与关键伏笔。" />
              </label>
              <div className="knowledge-section-heading">
                <div><strong>按因果顺序排列事件</strong><small>顺序会随项目知识修订固化，拖入单集前不会自动改变</small></div>
                <button type="button" onClick={() => setDraft((current) => ({
                  ...current,
                  events: [...current.events, { id: knowledgeId('event'), timeLabel: '', title: '', summary: '', participants: [] }],
                }))}><Plus size={13} /> 添加事件</button>
              </div>
              <ol className="knowledge-event-line">
                {draft.events.map((event, index) => (
                  <li key={event.id}>
                    <div className="knowledge-event-index"><Clock3 size={13} /><b>{index + 1}</b></div>
                    <article className="knowledge-structured-card">
                      <header>
                        <span>{event.timeLabel.trim() || `事件 ${index + 1}`}</span>
                        <div>
                          <button type="button" aria-label="上移事件" disabled={index === 0} onClick={() => moveEvent(index, -1)}><ArrowUp size={12} /></button>
                          <button type="button" aria-label="下移事件" disabled={index === draft.events.length - 1} onClick={() => moveEvent(index, 1)}><ArrowDown size={12} /></button>
                          <button type="button" aria-label="删除事件" onClick={() => setDraft((current) => ({ ...current, events: current.events.filter((item) => item.id !== event.id) }))}><Trash2 size={12} /></button>
                        </div>
                      </header>
                      <div className="knowledge-inline-fields">
                        <input value={event.timeLabel} maxLength={80} placeholder="时间标签，如：十年前 / 第三日" onChange={(change) => setDraft((current) => ({ ...current, events: current.events.map((item) => item.id === event.id ? { ...item, timeLabel: change.target.value } : item) }))} />
                        <input value={event.title} maxLength={120} placeholder="事件标题" onChange={(change) => setDraft((current) => ({ ...current, events: current.events.map((item) => item.id === event.id ? { ...item, title: change.target.value } : item) }))} />
                      </div>
                      <textarea value={event.summary} maxLength={4_000} placeholder="发生了什么、原因、结果和留下的伏笔" onChange={(change) => setDraft((current) => ({ ...current, events: current.events.map((item) => item.id === event.id ? { ...item, summary: change.target.value } : item) }))} />
                      <input value={event.participants.join('、')} maxLength={500} placeholder="参与人物，用顿号、逗号或换行分隔" onChange={(change) => setDraft((current) => ({ ...current, events: current.events.map((item) => item.id === event.id ? { ...item, participants: change.target.value.split(/[、,，\n]/).map((value) => value.trim()).filter(Boolean) } : item) }))} />
                    </article>
                  </li>
                ))}
              </ol>
              {draft.events.length === 0 && <div className="knowledge-structured-empty">尚无结构化事件节点。</div>}
            </div>
          )}

          {activeTab === 'relationships' && (
            <div className="knowledge-tab-panel knowledge-relationship-panel">
              <label className="knowledge-overview-field">
                <span><Network size={15} /> 人物关系总纲</span>
                <textarea value={draft.relationshipNotes} onChange={(event) => setDraft((current) => ({ ...current, relationshipNotes: event.target.value }))} placeholder="记录阵营、冲突和随事件变化的关系背景。" />
              </label>
              <div className="knowledge-graph-shell">
                <div className="knowledge-graph-summary"><strong>关系图</strong><span>{graph.nodes.length} 人物 · {graph.edges.length} 关系</span></div>
                <RelationshipGraph document={draft} />
              </div>
              <div className="knowledge-section-heading">
                <div><strong>关系边</strong><small>关系图只是当前结构化数据的可视投影，不另存一份平行状态</small></div>
                <button type="button" onClick={() => setDraft((current) => ({
                  ...current,
                  relationships: [...current.relationships, { id: knowledgeId('relation'), source: '', target: '', label: '', direction: 'directed', detail: '' }],
                }))}><Plus size={13} /> 添加关系</button>
              </div>
              <div className="knowledge-card-list">
                {draft.relationships.map((relationship, index) => (
                  <article key={relationship.id} className="knowledge-structured-card knowledge-relation-card">
                    <header><span>关系 {index + 1}</span><button type="button" aria-label={`删除人物关系 ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, relationships: current.relationships.filter((item) => item.id !== relationship.id) }))}><Trash2 size={13} /></button></header>
                    <div className="knowledge-relation-row">
                      <input value={relationship.source} maxLength={100} placeholder="人物 A" onChange={(event) => setDraft((current) => ({ ...current, relationships: current.relationships.map((item) => item.id === relationship.id ? { ...item, source: event.target.value } : item) }))} />
                      <ArrowRight size={15} />
                      <input value={relationship.target} maxLength={100} placeholder="人物 B" onChange={(event) => setDraft((current) => ({ ...current, relationships: current.relationships.map((item) => item.id === relationship.id ? { ...item, target: event.target.value } : item) }))} />
                      <select value={relationship.direction} onChange={(event) => setDraft((current) => ({ ...current, relationships: current.relationships.map((item) => item.id === relationship.id ? { ...item, direction: event.target.value as typeof relationship.direction } : item) }))}>
                        <option value="directed">A → B</option>
                        <option value="mutual">A ↔ B</option>
                      </select>
                    </div>
                    <input value={relationship.label} maxLength={100} placeholder="关系名称，如：师徒、宿敌、效忠" onChange={(event) => setDraft((current) => ({ ...current, relationships: current.relationships.map((item) => item.id === relationship.id ? { ...item, label: event.target.value } : item) }))} />
                    <textarea value={relationship.detail} maxLength={2_000} placeholder="关系背景、强弱、秘密与变化条件（可选）" onChange={(event) => setDraft((current) => ({ ...current, relationships: current.relationships.map((item) => item.id === relationship.id ? { ...item, detail: event.target.value } : item) }))} />
                  </article>
                ))}
              </div>
            </div>
          )}

          <section className="knowledge-history" aria-label="项目知识修订历史">
            <div className="knowledge-section-heading">
              <div><strong><History size={14} /> 不可变修订历史</strong><small>恢复不会覆盖旧记录，而会从所选快照创建一个新的项目 head</small></div>
              <span>{revisions.length} 个修订</span>
            </div>
            <div className="knowledge-history-list">
              {revisions.slice(0, 20).map((revision) => {
                const current = revision.id === snapshot?.revision?.id
                return (
                  <div key={revision.id} className={current ? 'current' : ''}>
                    <span><b>{revision.summary || '项目修订'}</b><small>{compactDate(revision.createdAt)} · {revision.id.slice(0, 8)}</small></span>
                    {current ? <em>当前</em> : <button type="button" disabled={dirty || state === 'restoring'} onClick={() => setRestoreCandidate(revision)}><RotateCcw size={12} /> 恢复</button>}
                  </div>
                )
              })}
            </div>
            {dirty && <p className="knowledge-history-warning">当前有未保存草稿。为避免误丢内容，修订恢复已禁用；请先保存或重新读取。</p>}
          </section>
        </>
      )}

      {snapshot && (
        <div className="knowledge-revision-bar">
          <span>知识修订 {snapshot.revision?.id.slice(0, 8) ?? '尚未保存'} · schema v2</span>
          <span>项目 ID {snapshot.project.id}</span>
        </div>
      )}

      {restoreCandidate && (
        <div className="knowledge-restore-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRestoreCandidate(null)
        }}>
          <section className="knowledge-restore-dialog" role="dialog" aria-modal="true" aria-label="恢复项目知识修订">
            <RotateCcw size={22} />
            <h3>恢复知识修订 {restoreCandidate.id.slice(0, 8)}？</h3>
            <p>将从该不可变快照创建新的项目修订。当前 head 与历史都不会被删除；任何单集已经固定的制作素材也不会被改写。</p>
            <div><button type="button" className="button secondary" onClick={() => setRestoreCandidate(null)}>取消</button><button type="button" className="button primary" disabled={state === 'restoring'} onClick={() => void restore()}>{state === 'restoring' ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />} 创建恢复修订</button></div>
          </section>
        </div>
      )}
    </section>
  )
}
