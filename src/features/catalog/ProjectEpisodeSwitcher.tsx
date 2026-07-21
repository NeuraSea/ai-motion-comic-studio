import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  FolderKanban,
  History,
  Library,
  LoaderCircle,
  Search,
} from 'lucide-react'

import type { EpisodeSummary, ProjectSummary } from '../../lib/api-types'
import type { RecentProductionEpisode } from './project-switcher-state'

export interface ProjectEpisodeSwitcherProps {
  projectTitle: string
  episodeTitle: string
  projects: readonly ProjectSummary[]
  episodesByProject: Readonly<Record<string, readonly EpisodeSummary[]>>
  activeProjectId: string | null
  activeEpisodeId: string | null
  recentEpisodes: readonly RecentProductionEpisode[]
  loading: boolean
  error: string
  switchingEpisodeId: string | null
  switchBlockedReason: string
  onSwitchEpisode: (projectId: string, episodeId: string) => Promise<boolean>
  onOpenCatalog: (projectId: string | null) => void
  onRefresh: () => void
}

interface ResolvedEpisode {
  project: ProjectSummary
  episode: EpisodeSummary
}

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function ProjectEpisodeSwitcher({
  projectTitle,
  episodeTitle,
  projects,
  episodesByProject,
  activeProjectId,
  activeEpisodeId,
  recentEpisodes,
  loading,
  error,
  switchingEpisodeId,
  switchBlockedReason,
  onSwitchEpisode,
  onOpenCatalog,
  onRefresh,
}: ProjectEpisodeSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setExpandedProjects((current) => {
      if (!activeProjectId || current.has(activeProjectId)) return current
      return new Set([...current, activeProjectId])
    })
    const focusFrame = window.requestAnimationFrame(() => searchRef.current?.focus())
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [activeProjectId, open])

  const recent = useMemo(() => recentEpisodes.flatMap((recentEpisode): ResolvedEpisode[] => {
    const project = projects.find((candidate) => candidate.id === recentEpisode.projectId)
    const episode = project
      ? (episodesByProject[project.id] ?? []).find((candidate) => candidate.id === recentEpisode.episodeId)
      : null
    return project && episode ? [{ project, episode }] : []
  }), [episodesByProject, projects, recentEpisodes])

  const queryValue = normalizedQuery(query)
  const visibleProjects = useMemo(() => projects.flatMap((project) => {
    const episodes = episodesByProject[project.id] ?? []
    if (!queryValue || normalizedQuery(project.title).includes(queryValue)) return [{ project, episodes }]
    const matchingEpisodes = episodes.filter((episode) => normalizedQuery(episode.title).includes(queryValue))
    return matchingEpisodes.length > 0 ? [{ project, episodes: matchingEpisodes }] : []
  }), [episodesByProject, projects, queryValue])

  const chooseEpisode = async (projectId: string, episodeId: string) => {
    if (switchingEpisodeId || (switchBlockedReason && episodeId !== activeEpisodeId)) return
    if (episodeId === activeEpisodeId && projectId === activeProjectId) {
      setOpen(false)
      return
    }
    if (await onSwitchEpisode(projectId, episodeId)) {
      setOpen(false)
      setQuery('')
    }
  }

  const episodeRow = ({ project, episode }: ResolvedEpisode, recentRow = false) => {
    const active = project.id === activeProjectId && episode.id === activeEpisodeId
    const switching = switchingEpisodeId === episode.id
    const disabled = Boolean(switchingEpisodeId) || Boolean(switchBlockedReason && !active)
    return (
      <button
        key={`${recentRow ? 'recent' : 'tree'}-${project.id}-${episode.id}`}
        type="button"
        className={`project-switcher-episode ${active ? 'active' : ''}`}
        onClick={() => void chooseEpisode(project.id, episode.id)}
        disabled={disabled}
        title={disabled && switchBlockedReason ? switchBlockedReason : `进入 ${project.title} / ${episode.title}`}
      >
        {recentRow ? <History size={14} /> : <Clapperboard size={14} />}
        <span>
          <strong>{episode.title}</strong>
          <small>{project.title} · {episode.status}</small>
        </span>
        {switching
          ? <LoaderCircle className="project-switcher-spinner" size={14} />
          : active
            ? <Check size={14} />
            : <ChevronRight size={14} />}
      </button>
    )
  }

  return (
    <div className="project-switcher-root" ref={rootRef}>
      <button
        type="button"
        className="project-switcher"
        title="切换项目或剧集"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="project-thumb" />
        <span>
          <strong>{projectTitle}</strong>
          <small>当前制作 · {episodeTitle}</small>
        </span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <section className="project-switcher-popover" role="dialog" aria-label="切换项目与剧集">
          <header>
            <div><small>PRODUCTION CONTEXT</small><strong>切换项目与剧集</strong></div>
            <button type="button" onClick={() => { setOpen(false); onOpenCatalog(activeProjectId) }}>
              <Library size={14} /> Catalog
            </button>
          </header>
          <label className="project-switcher-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目或剧集"
            />
          </label>

          {switchBlockedReason && (
            <div className="project-switcher-warning">{switchBlockedReason}</div>
          )}
          {error && (
            <div className="project-switcher-error">
              <span>{error}</span><button type="button" onClick={onRefresh}>重试</button>
            </div>
          )}

          <div className="project-switcher-scroll">
            {!queryValue && recent.length > 0 && (
              <div className="project-switcher-section">
                <div className="project-switcher-section-title"><History size={13} />最近打开</div>
                {recent.map((item) => episodeRow(item, true))}
              </div>
            )}

            <div className="project-switcher-section">
              <div className="project-switcher-section-title"><FolderKanban size={13} />全部项目</div>
              {loading && projects.length === 0 && <div className="project-switcher-empty">正在读取项目…</div>}
              {!loading && visibleProjects.length === 0 && (
                <div className="project-switcher-empty">{queryValue ? '没有匹配的项目或剧集' : '尚无项目'}</div>
              )}
              {visibleProjects.map(({ project, episodes }) => {
                const expanded = queryValue.length > 0 || expandedProjects.has(project.id) || project.id === activeProjectId
                return (
                  <div className="project-switcher-project" key={project.id}>
                    <button
                      type="button"
                      className="project-switcher-project-row"
                      aria-expanded={expanded}
                      onClick={() => setExpandedProjects((current) => {
                        const next = new Set(current)
                        if (next.has(project.id)) next.delete(project.id)
                        else next.add(project.id)
                        return next
                      })}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <FolderKanban size={14} />
                      <span><strong>{project.title}</strong><small>{episodes.length} 集</small></span>
                    </button>
                    {expanded && (
                      <div className="project-switcher-episodes">
                        {episodes.map((episode) => episodeRow({ project, episode }))}
                        {episodes.length === 0 && <div className="project-switcher-empty compact">该项目尚无剧集</div>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <footer>切换会恢复该集上次的制作阶段、镜头和 OpenCut 播放头。</footer>
        </section>
      )}
    </div>
  )
}
