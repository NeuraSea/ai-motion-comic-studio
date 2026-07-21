import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeDatabase } from './database.js'
import {
  ProjectNarratorVoiceProfileError,
  ProjectNarratorVoiceProfileRepository,
} from './project-narrator-voice-profiles.js'
import {
  projectSettingsEtag,
  projectVersionTokenFromEtag,
} from './project-version.js'
import { ProjectService } from './projects.js'
import { StoryRepository } from './story-repository.js'
import type { StoryCharacterVoiceProfile, StoryDocument } from './story-schema.js'

const NOW = '2026-07-14T00:00:00.000Z'

function story(): StoryDocument {
  return {
    version: 1,
    title: '长安龙脉',
    targetDurationSeconds: 30,
    bible: { logline: '剑客守城。', theme: '责任', tone: '紧张', visualStyle: '国风动画' },
    characters: [{
      id: 'ali',
      name: '阿离',
      role: '主角',
      storyDescription: '年轻剑客',
      visualDescription: '黑发红绳',
    }],
    locations: [{
      id: 'cliff',
      name: '断崖',
      storyDescription: '长安城外',
      visualDescription: '云海落日',
    }],
    props: [],
    scenes: [{
      id: 'scene-1',
      sequence: 0,
      title: '断崖',
      locationId: 'cliff',
      timeOfDay: '黄昏',
      description: '龙吟响起',
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `shot-${index + 1}`,
        sequence: index,
        code: `S${index + 1}`,
        title: `镜头 ${index + 1}`,
        description: '阿离看向云海',
        framing: '中景',
        movement: '推进',
        transition: '硬切',
        durationSeconds: 5,
        visualPrompt: '断崖云海',
        dialogueLines: index === 0
          ? [{
              id: 'narration-1',
              sequence: 0,
              kind: 'narration' as const,
              speaker: '',
              text: '龙脉在长安地底苏醒。',
            }]
          : index === 1
            ? [{
                id: 'dialogue-1',
                sequence: 0,
                kind: 'dialogue' as const,
                speaker: '阿离',
                text: '它醒了。',
              }]
            : [],
      })),
    }],
  }
}

function profile(voiceId = 'Chinese (Mandarin)_Narrator'): StoryCharacterVoiceProfile {
  return {
    version: 1,
    voiceId,
    providerId: 'minimax-speech',
    providerConfigRevision: 3,
    voiceType: 'system',
    voiceName: '沉稳旁白',
    descriptions: ['沉稳清晰的普通话旁白。'],
    selectionSource: 'manual',
    defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
    catalogFingerprint: 'a'.repeat(64),
    catalogObservedAt: NOW,
    historicalPin: false,
    updatedAt: NOW,
  }
}

test('project narrator profile has an independent audit chain and invalidates only narration audio dependencies', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({
      id: 'project-1',
      title: '漫剧',
      settings: { style: '国风动画' },
      createdAt: NOW,
      updatedAt: NOW,
    })
    const stories = new StoryRepository(database)
    const episode = stories.ensureEpisode('project-1', { id: 'episode-1', title: '第一集' })
    const applied = stories.applyStory(episode.id, story())
    const sourceRevisionId = applied.revision.id
    const beforeProject = database.getProject('project-1')!
    const beforeEtag = projectSettingsEtag(beforeProject)
    const lines = database.withSql((sql) => sql.all(`
      SELECT dialogue_lines.id, dialogue_lines.kind
        FROM dialogue_lines
        JOIN shots ON shots.id = dialogue_lines.shot_id
        JOIN scenes ON scenes.id = shots.scene_id
       WHERE scenes.episode_id = ?
       ORDER BY dialogue_lines.kind DESC
    `, episode.id))
    const narrationLineId = String(lines.find((line) => line.kind === 'narration')?.id)
    const dialogueLineId = String(lines.find((line) => line.kind === 'dialogue')?.id)
    const shotDatabaseId = String(database.withSql((sql) => sql.get(`
      SELECT shots.id FROM shots JOIN scenes ON scenes.id = shots.scene_id
       WHERE scenes.episode_id = ? ORDER BY shots.sequence LIMIT 1
    `, episode.id))?.id)

    for (const asset of [
      { id: 'narration-speech', kind: 'speech', mimeType: 'audio/mpeg' },
      { id: 'dialogue-speech', kind: 'speech', mimeType: 'audio/mpeg' },
      { id: 'storyboard-image', kind: 'storyboard.image', mimeType: 'image/png' },
      { id: 'shot-video', kind: 'shot.video', mimeType: 'video/mp4' },
      { id: 'export-video', kind: 'episode.export', mimeType: 'video/mp4' },
    ]) {
      database.createMediaAsset({
        ...asset,
        projectId: 'project-1',
        episodeId: episode.id,
        status: 'ready',
        filePath: `${asset.id}.bin`,
        source: 'provider',
        sourceRevisionId,
      })
    }
    database.withSql((sql) => {
      sql.run(`UPDATE dialogue_lines
                  SET speech_asset_id = 'narration-speech', voice_id = 'old-narrator', duration_seconds = 2
                WHERE id = ?`, narrationLineId)
      sql.run(`UPDATE dialogue_lines
                  SET speech_asset_id = 'dialogue-speech', voice_id = 'old-character', duration_seconds = 1
                WHERE id = ?`, dialogueLineId)
      sql.run(`UPDATE shots SET storyboard_asset_id = 'storyboard-image', video_asset_id = 'shot-video'
                WHERE id = ?`, shotDatabaseId)
      sql.run(`
        INSERT INTO exports (
          id, project_id, episode_id, status, timeline_snapshot_json, output_asset_id,
          specification_json, created_at, updated_at
        ) VALUES ('export-1', 'project-1', ?, 'succeeded', '{}', 'export-video', '{}', ?, ?)
      `, episode.id, NOW, NOW)
      sql.run(`
        INSERT INTO quality_reports (
          id, project_id, episode_id, export_id, status, checks_json, passed, created_at, completed_at
        ) VALUES ('quality-1', 'project-1', ?, 'export-1', 'passed', '{}', 1, ?, ?)
      `, episode.id, NOW, NOW)
    })
    database.createPipelineRun({
      id: 'pipeline-1',
      projectId: 'project-1',
      episodeId: episode.id,
      sourceRevisionId,
      status: 'succeeded',
      progress: 100,
      steps: {},
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    })
    database.createGenerationJob({
      id: 'narration-job',
      projectId: 'project-1',
      episodeId: episode.id,
      type: 'dialogue.speech.generate',
      status: 'running',
      resourceType: 'dialogue_line',
      resourceId: narrationLineId,
      input: {},
    })
    database.createGenerationJob({
      id: 'dialogue-job',
      projectId: 'project-1',
      episodeId: episode.id,
      type: 'dialogue.speech.generate',
      status: 'succeeded',
      resourceType: 'dialogue_line',
      resourceId: dialogueLineId,
      input: {},
    })

    const profiles = new ProjectNarratorVoiceProfileRepository(database)
    const saved = profiles.save({
      projectId: 'project-1',
      expectedProjectVersion: projectVersionTokenFromEtag(beforeEtag)!,
      profile: profile(),
    })

    const afterProject = database.getProject('project-1')!
    assert.equal(afterProject.currentRevisionId, sourceRevisionId)
    assert.notEqual(saved.state.projectEtag, beforeEtag)
    assert.deepEqual(saved.state.profile, profile())
    assert.deepEqual(afterProject.settings, {
      style: '国风动画',
      narratorVoiceProfile: profile(),
      narratorVoiceProfileRevisionId: saved.revision.id,
    })
    assert.deepEqual(database.getRevision(saved.revision.id)?.snapshot, {
      version: 1,
      kind: 'project.narrator-voice-profile',
      projectId: 'project-1',
      profile: profile(),
    })
    assert.equal(database.getMediaAsset('narration-speech')?.status, 'stale')
    assert.equal(database.getMediaAsset('dialogue-speech')?.status, 'ready')
    assert.equal(database.getMediaAsset('export-video')?.status, 'stale')
    assert.equal(database.getMediaAsset('storyboard-image')?.status, 'ready')
    assert.equal(database.getMediaAsset('shot-video')?.status, 'ready')
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT speech_asset_id, voice_id, duration_seconds FROM dialogue_lines WHERE id = ?
    `, narrationLineId)) }, {
      speech_asset_id: null,
      voice_id: null,
      duration_seconds: null,
    })
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT speech_asset_id, voice_id, duration_seconds FROM dialogue_lines WHERE id = ?
    `, dialogueLineId)) }, {
      speech_asset_id: 'dialogue-speech',
      voice_id: 'old-character',
      duration_seconds: 1,
    })
    assert.equal(database.getGenerationJob('narration-job')?.progressDetail.staleReason,
      'project_narrator_voice_profile_changed')
    assert.equal(database.getGenerationJob('dialogue-job')?.progressDetail.staleReason, undefined)
    assert.deepEqual(saved.stale.activeJobIds, ['narration-job'])
    assert.equal(database.getPipelineRun('pipeline-1')?.status, 'stale')
    assert.equal(database.withSql((sql) => sql.get(`SELECT status FROM exports WHERE id = 'export-1'`))?.status, 'stale')
    assert.equal(database.withSql((sql) => sql.get(`SELECT status FROM quality_reports WHERE id = 'quality-1'`))?.status, 'stale')
  } finally {
    database.close()
  }
})

test('project narrator profile uses a monotonic project-settings CAS and immutable deletion audit', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-1', title: '漫剧', createdAt: NOW, updatedAt: NOW })
    const profiles = new ProjectNarratorVoiceProfileRepository(database)
    const initial = profiles.get('project-1')
    assert.equal(initial.profile, null)
    const first = profiles.save({
      projectId: 'project-1',
      expectedProjectVersion: projectVersionTokenFromEtag(initial.projectEtag)!,
      profile: profile(),
    })
    assert.throws(() => profiles.save({
      projectId: 'project-1',
      expectedProjectVersion: projectVersionTokenFromEtag(initial.projectEtag)!,
      profile: profile('another-voice'),
    }), (error: unknown) => {
      assert.ok(error instanceof ProjectNarratorVoiceProfileError)
      assert.equal(error.code, 'REVISION_CONFLICT')
      assert.equal(error.currentEtag, first.state.projectEtag)
      return true
    })

    const removed = profiles.save({
      projectId: 'project-1',
      expectedProjectVersion: projectVersionTokenFromEtag(first.state.projectEtag)!,
      profile: null,
    })
    assert.equal(removed.state.profile, null)
    assert.equal(removed.state.revisionId, null)
    assert.equal(removed.revision.parentRevisionId, first.revision.id)
    assert.deepEqual(removed.revision.snapshot, {
      version: 1,
      kind: 'project.narrator-voice-profile',
      projectId: 'project-1',
      profile: null,
    })
    assert.equal(database.getProject('project-1')?.settings.narratorVoiceProfile, undefined)
    assert.equal(database.getProject('project-1')?.settings.narratorVoiceProfileRevisionId, undefined)
  } finally {
    database.close()
  }
})

test('project document updates preserve audited narrator settings and cannot inject reserved casting keys', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    const projects = new ProjectService(database)
    const initial = projects.ensureDefaultProject()
    const profiles = new ProjectNarratorVoiceProfileRepository(database)
    const saved = profiles.save({
      projectId: initial.project.id,
      expectedProjectVersion: projectVersionTokenFromEtag(profiles.get(initial.project.id).projectEtag)!,
      profile: profile(),
    })
    const replaced = projects.replaceSnapshot(initial.project.id, {
      ...initial.document,
      settings: {
        style: '赛博朋克',
        narratorVoiceProfile: { voiceId: 'injected-arbitrary-text' },
        narratorVoiceProfileRevisionId: 'injected-revision',
      },
    }, { expectedRevisionId: initial.revision.id })
    assert.equal(replaced.project.settings.style, '赛博朋克')
    assert.deepEqual(replaced.project.settings.narratorVoiceProfile, profile())
    assert.equal(replaced.project.settings.narratorVoiceProfileRevisionId, saved.revision.id)
    assert.deepEqual(profiles.get(initial.project.id).profile, profile())
  } finally {
    database.close()
  }
})
