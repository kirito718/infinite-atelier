import assert from 'node:assert/strict'
import test from 'node:test'

import * as backup from './project-backup.mjs'
const PROJECT = { version: 16, settings: { name: 'Recovery scene' }, objects: [], shots: [] }
const POSE = { id: 'pose-1', name: 'Unsaved pose', pose: 'idle', poseTime: 0.25, rigRoot: [1, 0, -2], joints: { mixamorigSpine2: [0.1, -0.2, 0.3] } }

function serialize(project, customPoses) {
  assert.equal(typeof backup.serializeProjectBackup, 'function', 'pose-inclusive backup is not implemented')
  return backup.serializeProjectBackup(project, customPoses)
}

function parse(serialized) {
  assert.equal(typeof backup.parseProjectBackup, 'function', 'validated recovery import is not implemented')
  return backup.parseProjectBackup(serialized)
}

test('recovery export includes the current unsaved pose library and round-trips both documents', () => {
  const poses = [structuredClone(POSE)]
  const serialized = serialize(PROJECT, poses)
  assert.deepEqual(JSON.parse(serialized), { ...PROJECT, customPoses: [POSE] })
  assert.deepEqual(parse(serialized), { project: PROJECT, customPoses: [POSE] })
  assert.equal(Object.hasOwn(PROJECT, 'customPoses'), false)
  poses[0].name = 'A later edit'
  assert.equal(parse(serialized).customPoses[0].name, 'Unsaved pose')
})

test('export uses the live pose library, not a stale library attached to project data', () => {
  const serialized = serialize({ ...PROJECT, customPoses: [{ id: 'old', name: 'Old pose' }] }, [POSE])
  assert.deepEqual(parse(serialized), { project: PROJECT, customPoses: [POSE] })
})

test('old project-only files signal that the existing pose library must be preserved', () => {
  const restored = parse(JSON.stringify(PROJECT))
  assert.deepEqual(restored.project, PROJECT)
  assert.equal(restored.customPoses, undefined)
})

test('an explicitly empty library is restored as empty, not treated as missing', () => {
  assert.deepEqual(parse(serialize(PROJECT, [])), { project: PROJECT, customPoses: [] })
})

test('legacy minimal poses and shot-only projects remain readable', () => {
  const project = { shots: [{ id: 'shot-1', objects: [] }] }
  const customPoses = [{ id: 'legacy', name: 'Legacy pose' }]
  assert.deepEqual(parse(JSON.stringify({ ...project, customPoses })), { project, customPoses })
})

test('invalid pose libraries are rejected in full before any import result is returned', async t => {
  for (const [name, customPoses] of [
    ['null library', null],
    ['object instead of library', {}],
    ['null entry', [null]],
    ['missing ID', [{ name: 'Pose' }]],
    ['invalid ID type', [{ ...POSE, id: 42 }]],
    ['blank name', [{ ...POSE, name: '  ' }]],
    ['invalid pose ID', [{ ...POSE, pose: {} }]],
    ['invalid pose time', [{ ...POSE, poseTime: '0.5' }]],
    ['invalid root dimensions', [{ ...POSE, rigRoot: [0, 0] }]],
    ['invalid root number', [{ ...POSE, rigRoot: [0, '1', 0] }]],
    ['null joints', [{ ...POSE, joints: null }]],
    ['joint list instead of map', [{ ...POSE, joints: [] }]],
    ['invalid joint dimensions', [{ ...POSE, joints: { mixamorigSpine2: [0, 0] } }]],
    ['invalid joint number', [{ ...POSE, joints: { mixamorigSpine2: [0, null, 0] } }]],
    ['duplicate IDs', [POSE, { ...POSE, name: 'Duplicate' }]],
    ['invalid entry after a valid entry', [POSE, { id: 'bad' }]],
  ]) {
    await t.test(name, () => {
      assert.throws(() => parse(JSON.stringify({ ...PROJECT, customPoses })), /姿势/)
    })
  }
})

test('non-finite pose coordinates are rejected even when JSON parses them as numbers', () => {
  const serialized = JSON.stringify({ ...PROJECT, customPoses: [POSE] }).replace('0.25', '1e400')
  assert.throws(() => parse(serialized), /姿势/)
})

test('invalid project data rejects the whole file even with a valid pose library', () => {
  for (const project of [null, [], {}, { customPoses: [POSE] }]) {
    assert.throws(() => parse(JSON.stringify(project)), /工程/)
  }
})
