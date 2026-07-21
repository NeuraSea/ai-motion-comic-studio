export type WorldEntryCategory = 'rule' | 'faction' | 'place' | 'culture' | 'visual'

export interface ProjectWorldEntry {
  id: string
  category: WorldEntryCategory
  title: string
  detail: string
}

export interface ProjectKnowledgeEvent {
  id: string
  timeLabel: string
  title: string
  summary: string
  participants: string[]
}

export interface ProjectKnowledgeRelationship {
  id: string
  source: string
  target: string
  label: string
  direction: 'directed' | 'mutual'
  detail: string
}

export interface ProjectKnowledgeDocument {
  version: 2
  sourceText: string
  worldbuilding: string
  eventLine: string
  relationshipNotes: string
  worldEntries: ProjectWorldEntry[]
  events: ProjectKnowledgeEvent[]
  relationships: ProjectKnowledgeRelationship[]
}

export const WORLD_ENTRY_CATEGORIES: ReadonlyArray<{
  value: WorldEntryCategory
  label: string
}> = [
  { value: 'rule', label: '世界规则' },
  { value: 'faction', label: '势力阵营' },
  { value: 'place', label: '地理地点' },
  { value: 'culture', label: '文化历史' },
  { value: 'visual', label: '视觉基调' },
]

const WORLD_ENTRY_CATEGORY_SET = new Set(WORLD_ENTRY_CATEGORIES.map((item) => item.value))

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function identifier(value: unknown): string {
  const candidate = text(value).trim()
  return candidate && candidate.length <= 200 ? candidate : ''
}

function uniqueTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const normalized = text(item).trim()
    if (!normalized || normalized.length > 100 || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function parseWorldEntry(value: unknown): ProjectWorldEntry | null {
  const item = record(value)
  if (!item) return null
  const id = identifier(item.id)
  const category = text(item.category)
  if (!id || !WORLD_ENTRY_CATEGORY_SET.has(category as WorldEntryCategory)) return null
  return {
    id,
    category: category as WorldEntryCategory,
    title: text(item.title),
    detail: text(item.detail),
  }
}

function parseEvent(value: unknown): ProjectKnowledgeEvent | null {
  const item = record(value)
  if (!item) return null
  const id = identifier(item.id)
  if (!id) return null
  return {
    id,
    timeLabel: text(item.timeLabel),
    title: text(item.title),
    summary: text(item.summary),
    participants: uniqueTextList(item.participants),
  }
}

function parseRelationship(value: unknown): ProjectKnowledgeRelationship | null {
  const item = record(value)
  if (!item) return null
  const id = identifier(item.id)
  if (!id) return null
  return {
    id,
    source: text(item.source),
    target: text(item.target),
    label: text(item.label),
    direction: item.direction === 'mutual' ? 'mutual' : 'directed',
    detail: text(item.detail),
  }
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value.id)) return false
    seen.add(value.id)
    return true
  })
}

function list<T>(value: unknown, parser: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return []
  return value.map(parser).filter((item): item is T => item !== null)
}

export function emptyProjectKnowledgeDocument(): ProjectKnowledgeDocument {
  return {
    version: 2,
    sourceText: '',
    worldbuilding: '',
    eventLine: '',
    relationshipNotes: '',
    worldEntries: [],
    events: [],
    relationships: [],
  }
}

/**
 * Reads both the original four-text-field document and the structured v2
 * shape. Invalid structured rows are ignored rather than becoming editable
 * identities, while the legacy text is always retained verbatim.
 */
export function projectKnowledgeFromDocument(
  projectDocument: Record<string, unknown>,
): ProjectKnowledgeDocument {
  const knowledge = record(projectDocument.knowledge) ?? projectDocument
  return {
    version: 2,
    sourceText: text(knowledge.sourceText),
    worldbuilding: text(knowledge.worldbuilding),
    eventLine: text(knowledge.eventLine),
    relationshipNotes: text(knowledge.relationshipNotes),
    worldEntries: uniqueById(list(knowledge.worldEntries, parseWorldEntry)),
    events: uniqueById(list(knowledge.events, parseEvent)),
    relationships: uniqueById(list(knowledge.relationships, parseRelationship)),
  }
}

export function serializeProjectKnowledge(
  knowledge: ProjectKnowledgeDocument,
): Record<string, unknown> {
  return {
    version: 2,
    sourceText: knowledge.sourceText,
    worldbuilding: knowledge.worldbuilding,
    eventLine: knowledge.eventLine,
    relationshipNotes: knowledge.relationshipNotes,
    worldEntries: knowledge.worldEntries.map((entry) => ({ ...entry })),
    events: knowledge.events.map((event) => ({
      ...event,
      participants: [...event.participants],
    })),
    relationships: knowledge.relationships.map((relationship) => ({ ...relationship })),
  }
}

export function sameProjectKnowledge(
  left: ProjectKnowledgeDocument,
  right: ProjectKnowledgeDocument,
): boolean {
  return JSON.stringify(serializeProjectKnowledge(left))
    === JSON.stringify(serializeProjectKnowledge(right))
}

export function projectKnowledgeIsMeaningful(knowledge: ProjectKnowledgeDocument): boolean {
  return Boolean(
    knowledge.sourceText.trim()
    || knowledge.worldbuilding.trim()
    || knowledge.eventLine.trim()
    || knowledge.relationshipNotes.trim()
    || knowledge.worldEntries.length
    || knowledge.events.length
    || knowledge.relationships.length,
  )
}

export interface RelationshipGraphNode {
  id: string
  label: string
  x: number
  y: number
}

export interface RelationshipGraphEdge {
  id: string
  source: RelationshipGraphNode
  target: RelationshipGraphNode
  label: string
  direction: 'directed' | 'mutual'
}

/** Deterministic circular projection used only for display, never as storage. */
export function projectRelationshipGraph(
  relationships: readonly ProjectKnowledgeRelationship[],
  width = 640,
  height = 360,
): { nodes: RelationshipGraphNode[]; edges: RelationshipGraphEdge[] } {
  const names: string[] = []
  const seen = new Set<string>()
  for (const relationship of relationships) {
    for (const raw of [relationship.source, relationship.target]) {
      const name = raw.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
  }
  const radius = Math.max(48, Math.min(width, height) / 2 - 64)
  const nodes = names.map((label, index): RelationshipGraphNode => {
    const angle = names.length === 1
      ? -Math.PI / 2
      : -Math.PI / 2 + index * (Math.PI * 2 / names.length)
    return {
      id: `node-${index}`,
      label,
      x: Math.round((width / 2 + Math.cos(angle) * radius) * 100) / 100,
      y: Math.round((height / 2 + Math.sin(angle) * radius) * 100) / 100,
    }
  })
  const byLabel = new Map(nodes.map((node) => [node.label, node]))
  const edges = relationships.flatMap((relationship): RelationshipGraphEdge[] => {
    const source = byLabel.get(relationship.source.trim())
    const target = byLabel.get(relationship.target.trim())
    if (!source || !target || source === target) return []
    return [{
      id: relationship.id,
      source,
      target,
      label: relationship.label.trim(),
      direction: relationship.direction,
    }]
  })
  return { nodes, edges }
}
