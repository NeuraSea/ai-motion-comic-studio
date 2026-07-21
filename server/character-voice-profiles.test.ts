import assert from 'node:assert/strict'
import test from 'node:test'

import { CharacterVoiceProfileRepository } from './character-voice-profiles.js'
import { initializeDatabase } from './database.js'
import { episodeEtag, versionTokenFromEtag } from './episode-version.js'
import { SQLiteJobRepository } from './repositories.js'
import { StoryRepository } from './story-repository.js'
import type { StoryCharacterVoiceProfile, StoryDocument } from './story-schema.js'
import type { JsonObject } from './types.js'
import { JobWorker } from './worker.js'

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
        dialogueLines: index === 0 ? [{
          id: 'line-1',
          sequence: 0,
          kind: 'dialogue' as const,
          speaker: '阿离',
          text: '它醒了。',
        }] : [],
      })),
    }],
  }
}

function profile(updatedAt = '2026-07-14T00:00:00.000Z'): StoryCharacterVoiceProfile {
  return {
    version: 1,
    voiceId: 'Chinese (Mandarin)_Heroic_Young_Woman',
    providerId: 'minimax-speech',
    providerConfigRevision: 3,
    voiceType: 'system',
    voiceName: '英气少女',
    descriptions: ['坚定、清晰的年轻女性普通话音色。'],
    selectionSource: 'agentic',
    selectionRationale: '符合年轻剑客的克制和果断。',
    profileTags: ['年轻', '克制', '英气'],
    defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0 },
    sceneDirections: [{
      sceneId: 'scene-1',
      emotion: 'whisper',
      speed: 0.82,
      pitch: -1,
      rationale: '压低声音表现警觉。',
    }],
    recommendationJobId: 'recommendation-job-1',
    catalogFingerprint: 'a'.repeat(64),
    catalogObservedAt: '2026-07-14T00:00:00.000Z',
    historicalPin: false,
    updatedAt,
  }
}

test('character voice profile uses an audit revision + Episode ETag without replacing Story source or visual media', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-1', title: '漫剧' })
    const stories = new StoryRepository(database)
    const episode = stories.ensureEpisode('project-1', { id: 'episode-1', title: '第一集' })
    const applied = stories.applyStory(episode.id, story())
    const sourceRevisionId = applied.revision.id
    const beforeEtag = episodeEtag(applied.episode)
    const rows = database.withSql((sql) => ({
      character: sql.get(`SELECT id FROM characters WHERE episode_id = ?`, episode.id)!,
      line: sql.get(`
        SELECT dialogue_lines.id FROM dialogue_lines
        JOIN shots ON shots.id = dialogue_lines.shot_id
        JOIN scenes ON scenes.id = shots.scene_id
        WHERE scenes.episode_id = ?
      `, episode.id)!,
      shot: sql.get(`
        SELECT shots.id FROM shots JOIN scenes ON scenes.id = shots.scene_id
        WHERE scenes.episode_id = ? ORDER BY shots.sequence LIMIT 1
      `, episode.id)!,
    }))
    const characterDatabaseId = rows.character.id as string
    const lineDatabaseId = rows.line.id as string
    const shotDatabaseId = rows.shot.id as string

    for (const asset of [
      { id: 'speech-asset', kind: 'speech', mimeType: 'audio/mpeg' },
      { id: 'storyboard-asset', kind: 'storyboard.image', mimeType: 'image/png' },
      { id: 'video-asset', kind: 'shot.video', mimeType: 'video/mp4' },
      { id: 'export-asset', kind: 'episode.export', mimeType: 'video/mp4' },
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
    const now = '2026-07-14T00:00:00.000Z'
    database.withSql((sql) => {
      sql.run(`UPDATE dialogue_lines SET speech_asset_id = ?, voice_id = ?, duration_seconds = 1 WHERE id = ?`,
        'speech-asset', 'old-voice', lineDatabaseId)
      sql.run(`UPDATE shots SET storyboard_asset_id = ?, video_asset_id = ? WHERE id = ?`,
        'storyboard-asset', 'video-asset', shotDatabaseId)
      sql.run(`
        INSERT INTO exports (
          id, project_id, episode_id, status, timeline_snapshot_json, output_asset_id,
          specification_json, created_at, updated_at
        ) VALUES ('export-1', 'project-1', ?, 'succeeded', '{}', 'export-asset', '{}', ?, ?)
      `, episode.id, now, now)
      sql.run(`
        INSERT INTO quality_reports (
          id, project_id, episode_id, export_id, status, checks_json, passed, created_at, completed_at
        ) VALUES ('quality-1', 'project-1', ?, 'export-1', 'passed', '{}', 1, ?, ?)
      `, episode.id, now, now)
    })
    database.createGenerationJob({
      id: 'speech-job-1',
      projectId: 'project-1',
      episodeId: episode.id,
      type: 'dialogue.speech.generate',
      status: 'succeeded',
      resourceType: 'dialogue_line',
      resourceId: lineDatabaseId,
      input: {},
    })

    const profiles = new CharacterVoiceProfileRepository(database)
    const saved = profiles.save({
      projectId: 'project-1',
      episodeId: episode.id,
      characterId: 'ali',
      expectedEpisodeVersion: versionTokenFromEtag(beforeEtag)!,
      profile: profile(),
    })

    const after = stories.getEpisode(episode.id)!
    assert.equal(after.sourceRevisionId, sourceRevisionId)
    assert.notEqual(saved.episodeEtag, beforeEtag)
    assert.equal(database.getProject('project-1')?.currentRevisionId, sourceRevisionId)
    assert.equal(saved.record?.characterVersion, 1)
    assert.deepEqual(database.getRevision(saved.revision.id)?.snapshot, {
      version: 1,
      kind: 'character.voice-profile',
      projectId: 'project-1',
      episodeId: episode.id,
      characterId: 'ali',
      characterName: '阿离',
      profile: profile(),
    })
    assert.deepEqual(stories.getStory(episode.id)?.characters[0].voiceProfile, profile())
    assert.equal(database.getMediaAsset('speech-asset')?.status, 'stale')
    assert.equal(database.getMediaAsset('export-asset')?.status, 'stale')
    assert.equal(database.getMediaAsset('storyboard-asset')?.status, 'ready')
    assert.equal(database.getMediaAsset('video-asset')?.status, 'ready')
    assert.equal(database.getGenerationJob('speech-job-1')?.progressDetail.staleReason, 'character_voice_profile_changed')
    assert.deepEqual({ ...database.withSql((sql) => sql.get(`
      SELECT speech_asset_id, voice_id, duration_seconds FROM dialogue_lines WHERE id = ?
    `, lineDatabaseId)) }, {
      speech_asset_id: null,
      voice_id: null,
      duration_seconds: null,
    })
  } finally {
    database.close()
  }
})

test('story regeneration and old Story restore preserve the independently audited casting profile', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-1', title: '漫剧' })
    const stories = new StoryRepository(database)
    const episode = stories.ensureEpisode('project-1', { id: 'episode-1', title: '第一集' })
    const original = stories.applyStory(episode.id, story())
    const profiles = new CharacterVoiceProfileRepository(database)
    const first = profiles.save({
      projectId: 'project-1',
      episodeId: episode.id,
      characterId: 'ali',
      expectedEpisodeVersion: versionTokenFromEtag(episodeEtag(original.episode))!,
      profile: profile(),
    })

    const regenerated = stories.applyStory(episode.id, story())
    assert.deepEqual(regenerated.story.characters[0].voiceProfile, profile())
    const restored = stories.restoreStoryRevision(episode.id, original.revision.id, {
      expectedRevisionId: regenerated.revision.id,
    })
    assert.deepEqual(restored.story.characters[0].voiceProfile, profile())
    assert.equal(profiles.get('project-1', episode.id, 'ali')?.revisionId, first.revision.id)
  } finally {
    database.close()
  }
})

test('legacy fractional MiniMax pitch is repaired into a new immutable audit revision', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-1', title: '漫剧' })
    const stories = new StoryRepository(database)
    const episode = stories.ensureEpisode('project-1', { id: 'episode-1', title: '第一集' })
    stories.applyStory(episode.id, story())
    const row = database.withSql((sql) => sql.get(
      'SELECT id, metadata_json FROM characters WHERE episode_id = ?',
      episode.id,
    ))!
    const malformed = {
      ...profile(),
      defaultDelivery: { emotion: 'calm', speed: 0.95, pitch: 0.05 },
      sceneDirections: [{
        sceneId: 'scene-1',
        emotion: 'whisper',
        speed: 0.82,
        pitch: -0.51,
        rationale: '旧版模型错误地返回了小数音高。',
      }],
    }
    const prior = database.createRevision({
      projectId: 'project-1',
      summary: '旧版角色声线',
      snapshot: {
        version: 1,
        kind: 'character.voice-profile',
        projectId: 'project-1',
        episodeId: episode.id,
        characterId: 'ali',
        characterName: '阿离',
        profile: malformed as unknown as JsonObject,
      },
    })
    const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>
    metadata.voiceProfile = malformed
    metadata.voiceProfileRevisionId = prior.id
    database.withSql((sql) => sql.run(
      'UPDATE characters SET metadata_json = ? WHERE id = ?',
      JSON.stringify(metadata),
      String(row.id),
    ))

    const profiles = new CharacterVoiceProfileRepository(database)
    const repaired = profiles.repairLegacyFractionalPitches()
    assert.equal(repaired.repaired, 1)
    assert.equal(repaired.revisionIds.length, 1)
    assert.equal(database.getRevision(repaired.revisionIds[0])?.parentRevisionId, prior.id)
    assert.equal((database.getRevision(prior.id)?.snapshot.profile as JsonObject)
      .defaultDelivery && ((database.getRevision(prior.id)?.snapshot.profile as JsonObject)
        .defaultDelivery as JsonObject).pitch, 0.05)
    assert.equal(profiles.get('project-1', episode.id, 'ali')?.profile.defaultDelivery?.pitch, 0)
    assert.equal(profiles.get('project-1', episode.id, 'ali')?.profile.sceneDirections?.[0].pitch, -1)
    assert.equal(stories.getStory(episode.id)?.characters[0].voiceProfile?.defaultDelivery?.pitch, 0)
    assert.equal(profiles.repairLegacyFractionalPitches().repaired, 0)
  } finally {
    database.close()
  }
})

test('profile writes reject stale Episode ETags', () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-1', title: '漫剧' })
    const stories = new StoryRepository(database)
    const episode = stories.ensureEpisode('project-1', { id: 'episode-1' })
    stories.applyStory(episode.id, story())
    const profiles = new CharacterVoiceProfileRepository(database)
    assert.throws(() => profiles.save({
      projectId: 'project-1',
      episodeId: episode.id,
      characterId: 'ali',
      expectedEpisodeVersion: 'episode.stale',
      profile: profile(),
    }), (error: unknown) => (
      typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'REVISION_CONFLICT'
    ))
  } finally {
    database.close()
  }
})

test('profile invalidation lets worker cancellation preserve an ambiguous paid submission', async () => {
  const database = initializeDatabase({ databasePath: ':memory:', legacyStatePath: false })
  try {
    database.createProject({ id: 'project-1', title: '漫剧' })
    const stories = new StoryRepository(database)
    const episode = stories.ensureEpisode('project-1', { id: 'episode-1', title: '第一集' })
    const applied = stories.applyStory(episode.id, story())
    const rows = database.withSql((sql) => ({
      character: sql.get('SELECT id FROM characters WHERE episode_id = ?', episode.id)!,
      line: sql.get(`
        SELECT dialogue_lines.id FROM dialogue_lines
        JOIN shots ON shots.id = dialogue_lines.shot_id
        JOIN scenes ON scenes.id = shots.scene_id
        WHERE scenes.episode_id = ?
      `, episode.id)!,
    }))
    const lineDatabaseId = rows.line.id as string
    database.createGenerationJob({
      id: 'active-paid-speech',
      projectId: 'project-1',
      episodeId: episode.id,
      type: 'dialogue.speech.generate',
      status: 'waiting_provider',
      progress: 5,
      resourceType: 'provider:speech',
      resourceId: lineDatabaseId,
      input: {},
      providerState: {
        operation: 'dialogue.speech.generate',
        phase: 'submitting',
        clientRequestId: 'active-paid-speech',
        providerSupportsIdempotency: false,
      },
    })

    const profiles = new CharacterVoiceProfileRepository(database)
    const saved = profiles.save({
      projectId: 'project-1',
      episodeId: episode.id,
      characterId: 'ali',
      expectedEpisodeVersion: versionTokenFromEtag(episodeEtag(applied.episode))!,
      profile: profile(),
    })
    assert.deepEqual(saved.stale.activeJobIds, ['active-paid-speech'])
    assert.equal(database.getGenerationJob('active-paid-speech')?.status, 'waiting_provider')
    assert.equal(
      database.getGenerationJob('active-paid-speech')?.progressDetail.staleReason,
      'character_voice_profile_changed',
    )

    const worker = new JobWorker(new SQLiteJobRepository(database))
    const cancelled = await worker.cancel('active-paid-speech', '角色声线已修改')
    assert.equal(cancelled?.status, 'failed')
    assert.equal(cancelled?.error?.code, 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN')
    assert.equal(database.getGenerationJob('active-paid-speech')?.status, 'failed')
  } finally {
    database.close()
  }
})
