import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OPENPOSE_KEYPOINTS,
  clampDepth,
  isControlRenderMode,
  poseConnections,
  projectPoseKeypoints,
  validateControlCaptureResult,
} from './control-passes.js'

const camera = {
  position: [0, 1.07, 5],
  rotation: [0, 0, 0],
  focalLength: 50,
  aspectRatio: '1:1',
}

const standingPerson = {
  type: 'person',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  rigRoot: [0, 0, 0],
  joints: {},
}

test('projects a standing rig into stable ordered OpenPose keypoints', () => {
  const first = projectPoseKeypoints({ object: standingPerson, camera, width: 640, height: 640 })
  const second = projectPoseKeypoints({ object: standingPerson, camera, width: 640, height: 640 })

  assert.deepEqual(first, second)
  assert.deepEqual(first.map(point => point.name), OPENPOSE_KEYPOINTS.map(point => point.name))
  assert.ok(poseConnections.length > 0)

  for (const point of first) {
    if (!point.visible) continue
    assert.ok(point.x >= 0 && point.x <= 640, `${point.name} x is within bounds`)
    assert.ok(point.y >= 0 && point.y <= 640, `${point.name} y is within bounds`)
  }
})

test('translates the projected rig with its scene object', () => {
  const centered = projectPoseKeypoints({ object: standingPerson, camera, width: 640, height: 640 })
  const translated = projectPoseKeypoints({
    object: { ...standingPerson, position: [0.8, 0, 0] },
    camera,
    width: 640,
    height: 640,
  })

  const centeredNeck = centered.find(point => point.name === 'neck')
  const translatedNeck = translated.find(point => point.name === 'neck')
  assert.equal(centeredNeck.visible, true)
  assert.equal(translatedNeck.visible, true)
  assert.ok(translatedNeck.x > centeredNeck.x)
})

test('marks a rig behind the camera as not visible', () => {
  const points = projectPoseKeypoints({
    object: { ...standingPerson, position: [0, 0, 7] },
    camera,
    width: 640,
    height: 640,
  })

  assert.ok(points.every(point => point.visible === false))
})

test('clamps depth values to the unit interval', () => {
  assert.equal(clampDepth(-0.01), 0)
  assert.equal(clampDepth(0.25), 0.25)
  assert.equal(clampDepth(1.01), 1)
})

test('accepts only supported control render modes', () => {
  assert.equal(isControlRenderMode('beauty'), true)
  assert.equal(isControlRenderMode('pose'), true)
  assert.equal(isControlRenderMode('depth'), true)
  assert.equal(isControlRenderMode('normal'), false)
  assert.equal(isControlRenderMode(undefined), false)
})

test('requires requested pose and depth passes to match capture dimensions', () => {
  const pass = { blob: new Blob(['pass'], { type: 'image/png' }), mimeType: 'image/png', width: 640, height: 480 }
  const capture = { shotId: 'shot-01', frame: 12, pose: pass, depth: { ...pass } }

  assert.equal(validateControlCaptureResult(capture, { passes: ['pose', 'depth'], width: 640, height: 480 }), true)
  assert.equal(validateControlCaptureResult({ ...capture, depth: { ...pass, height: 479 } }, { passes: ['pose', 'depth'], width: 640, height: 480 }), false)
  assert.equal(validateControlCaptureResult({ ...capture, depth: undefined }, { passes: ['pose', 'depth'], width: 640, height: 480 }), false)
})
