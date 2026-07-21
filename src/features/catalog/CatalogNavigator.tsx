import { useMemo, useState } from 'react'
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  FolderKanban,
  Layers3,
  Plus,
} from 'lucide-react'

import type { EpisodeSummary, ProjectSummary } from '../../lib/api-types'
import './CatalogNavigator.css'

export interface CatalogNavigatorProps {
  projects: readonly ProjectSummary[]
  episodesByProject: Readonly<Record<string, readonly EpisodeSummary[]>>
  selectedProjectId: string | null
  selectedEpisodeId: string | null
  mode: 'knowledge' | 'assets'
  loading: boolean
  error: string
  onSelectProject: (projectId: string) => void
  onSelectEpisode: (projectId: string, episodeId: string) => void
  onOpenProduction: (projectId: string, episodeId: string) => void
  onCreateProject: (title: string) => Promise<void>
  onCreateEpisode: (projectId: string, title: string) => Promise<void>
}

function nextEpisodeTitle(episodes: readonly EpisodeSummary[]): string {
  const maximum = episodes.reduce((value, episode) => Math.max(value, episode.sortOrder + 1), 0)
  return `第 ${Math.max(1, maximum + 1)} 集`
}

export function CatalogNavigator({
  projects,
  episodesByProject,
  selectedProjectId,
  selectedEpisodeId,
  mode,
  loading,
  error,
  onSelectProject,
  onSelectEpisode,
  onOpenProduction,
  onCreateProject,
  onCreateEpisode,
}: CatalogNavigatorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState<'project' | 'episode' | null>(null)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  const submit = async () => {
    const title = draft.trim()
    if (!title || submitting) return
    setSubmitting(true)
    try {
      if (creating === 'project') await onCreateProject(title)
      if (creating === 'episode' && selectedProjectId) await onCreateEpisode(selectedProjectId, title)
      setCreating(null)
      setDraft('')
    } finally {
      setSubmitting(false)
    }
  }

  const startCreateEpisode = () => {
    if (!selectedProjectId) return
    setDraft(nextEpisodeTitle(episodesByProject[selectedProjectId] ?? []))
    setCreating('episode')
  }

  return (
    <aside className="catalog-navigator" aria-label="项目与剧集 Catalog">
      <div className="catalog-navigator-heading">
        <div>
          <small>GLOBAL CATALOG</small>
          <strong>项目与剧集</strong>
        </div>
        <button
          className="catalog-icon-button"
          aria-label="新建项目"
          title="新建项目"
          onClick={() => { setDraft(''); setCreating('project') }}
        ><Plus size={16} /></button>
      </div>

      {error && <div className="catalog-error">{error}</div>}
      {loading && projects.length === 0 && <div className="catalog-empty">正在读取 Catalog…</div>}
      {!loading && projects.length === 0 && <div className="catalog-empty">尚无项目，请先新建项目。</div>}

      <div className="catalog-tree" role="tree">
        {projects.map((project) => {
          const episodes = episodesByProject[project.id] ?? []
          const open = expanded.has(project.id) || project.id === selectedProjectId
          const selected = project.id === selectedProjectId && selectedEpisodeId === null
          return (
            <div className="catalog-project" key={project.id} role="treeitem" aria-expanded={open}>
              <div className={`catalog-project-row ${selected ? 'selected' : ''}`}>
                <button
                  className="catalog-disclosure"
                  aria-label={`${open ? '收起' : '展开'} ${project.title}`}
                  onClick={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(project.id)) next.delete(project.id)
                    else next.add(project.id)
                    return next
                  })}
                >{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                <button className="catalog-project-select" onClick={() => onSelectProject(project.id)}>
                  <FolderKanban size={15} />
                  <span><strong>{project.title}</strong><small>{episodes.length} 集</small></span>
                </button>
              </div>
              {open && (
                <div className="catalog-episodes" role="group">
                  <button
                    className={`catalog-scope-row ${selected ? 'selected' : ''}`}
                    onClick={() => onSelectProject(project.id)}
                  >
                    {mode === 'knowledge' ? <BookOpenText size={14} /> : <Layers3 size={14} />}
                    <span>{mode === 'knowledge' ? '项目原著与世界观' : '项目全部素材'}</span>
                  </button>
                  {episodes.map((episode) => {
                    const episodeSelected = project.id === selectedProjectId && episode.id === selectedEpisodeId
                    return (
                      <div className={`catalog-episode-row ${episodeSelected ? 'selected' : ''}`} key={episode.id}>
                        <button onClick={() => onSelectEpisode(project.id, episode.id)}>
                          <Clapperboard size={13} />
                          <span><strong>{episode.title}</strong><small>{episode.status}</small></span>
                        </button>
                        <button
                          className="catalog-enter-production"
                          aria-label={`进入 ${episode.title} 制作`}
                          title="进入该集完整制作流程"
                          onClick={() => onOpenProduction(project.id, episode.id)}
                        ><ChevronRight size={14} /></button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="catalog-navigator-footer">
        <button disabled={!selectedProjectId} onClick={startCreateEpisode}><Plus size={14} /> 新建剧集</button>
        {selectedProject && <small>当前浏览：{selectedProject.title}</small>}
      </div>

      {creating && (
        <div className="catalog-create-panel" role="group" aria-label={creating === 'project' ? '新建项目' : '新建剧集'}>
          <strong>{creating === 'project' ? '新建项目' : `在「${selectedProject?.title ?? ''}」中新建剧集`}</strong>
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
              if (event.key === 'Escape') setCreating(null)
            }}
            maxLength={200}
            placeholder={creating === 'project' ? '项目名称' : '剧集名称'}
          />
          <div>
            <button onClick={() => setCreating(null)} disabled={submitting}>取消</button>
            <button className="primary" onClick={() => void submit()} disabled={!draft.trim() || submitting}>
              {submitting ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
