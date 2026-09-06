import { OPENPOSE_JOINT_MAPPING, poseForObject } from './rig.js'

export const OPENPOSE_KEYPOINTS = Object.freeze(OPENPOSE_JOINT_MAPPING.map(({ name }) => ({ name })))

export const poseConnections = Object.freeze([
  ['nose', 'neck'],
  ['neck', 'rightShoulder'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['neck', 'leftShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['neck', 'rightHip'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
  ['neck', 'leftHip'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['rightHip', 'leftHip'],
])

const CONTROL_RENDER_MODES = new Set(['beauty', 'pose', 'depth'])

export function isControlRenderMode(value) {
  return CONTROL_RENDER_MODES.has(value)
}

export function validateControlCaptureResult(result, request) {
  const requestedPasses = request?.passes || []
  const width = Number(request?.width)
  const height = Number(request?.height)
  if (!result || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return false

  return requestedPasses.every(kind => {
    const pass = result[kind]
    return (kind === 'pose' || kind === 'depth')
      && pass?.blob instanceof Blob
      && pass.mimeType === 'image/png'
      && pass.width === width
      && pass.height === height
  })
}

const REST_JOINTS = Object.freeze({
  mixamorigHips: { parent: null, position: [0, 1.07, 0] },
  mixamorigSpine: { parent: 'mixamorigHips', position: [0, 0.2, 0] },
  mixamorigSpine1: { parent: 'mixamorigSpine', position: [0, 0.2, 0] },
  mixamorigSpine2: { parent: 'mixamorigSpine1', position: [0, 0.22, 0] },
  mixamorigNeck: { parent: 'mixamorigSpine2', position: [0, 0.19, 0] },
  mixamorigHead: { parent: 'mixamorigNeck', position: [0, 0.2, 0] },
  mixamorigLeftShoulder: { parent: 'mixamorigSpine2', position: [-0.18, 0.08, 0] },
  mixamorigLeftArm: { parent: 'mixamorigLeftShoulder', position: [-0.16, 0, 0] },
  mixamorigLeftForeArm: { parent: 'mixamorigLeftArm', position: [-0.39, 0, 0] },
  mixamorigLeftHand: { parent: 'mixamorigLeftForeArm', position: [-0.35, 0, 0] },
  mixamorigRightShoulder: { parent: 'mixamorigSpine2', position: [0.18, 0.08, 0] },
  mixamorigRightArm: { parent: 'mixamorigRightShoulder', position: [0.16, 0, 0] },
  mixamorigRightForeArm: { parent: 'mixamorigRightArm', position: [0.39, 0, 0] },
  mixamorigRightHand: { parent: 'mixamorigRightForeArm', position: [0.35, 0, 0] },
  mixamorigLeftUpLeg: { parent: 'mixamorigHips', position: [-0.17, -0.04, 0] },
  mixamorigLeftLeg: { parent: 'mixamorigLeftUpLeg', position: [0, -0.55, 0] },
  mixamorigLeftFoot: { parent: 'mixamorigLeftLeg', position: [0, -0.52, 0] },
  mixamorigRightUpLeg: { parent: 'mixamorigHips', position: [0.17, -0.04, 0] },
  mixamorigRightLeg: { parent: 'mixamorigRightUpLeg', position: [0, -0.55, 0] },
  mixamorigRightFoot: { parent: 'mixamorigRightLeg', position: [0, -0.52, 0] },
})

const finite = value => Number.isFinite(value) ? value : 0
const vector3 = (value, fallback = [0, 0, 0]) => Array.isArray(value) && value.length >= 3
  ? [finite(Number(value[0])), finite(Number(value[1])), finite(Number(value[2]))]
  : [...fallback]

const multiplyQuaternions = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
]

const invertQuaternion = ([x, y, z, w]) => [-x, -y, -z, w]

const quaternionFromEulerXYZ = ([x, y, z]) => {
  const c1 = Math.cos(x / 2)
  const c2 = Math.cos(y / 2)
  const c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2)
  const s2 = Math.sin(y / 2)
  const s3 = Math.sin(z / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

const rotateVector = ([x, y, z], [qx, qy, qz, qw]) => {
  const ix = qw * x + qy * z - qz * y
  const iy = qw * y + qz * x - qx * z
  const iz = qw * z + qx * y - qy * x
  const iw = -qx * x - qy * y - qz * z
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ]
}

const addVectors = (left, right) => left.map((value, index) => value + right[index])
const scaleVector = (vector, scale) => vector.map((value, index) => value * scale[index])

function worldJointTransforms(object) {
  const rig = poseForObject(object)
  const objectPosition = vector3(object?.position)
  const objectRotation = quaternionFromEulerXYZ(vector3(object?.rotation))
  const objectScale = vector3(object?.scale, [1, 1, 1])
  const root = vector3(rig.root)
  const transforms = new Map()

  const resolve = jointId => {
    const existing = transforms.get(jointId)
    if (existing) return existing

    const definition = REST_JOINTS[jointId]
    if (!definition) return null
    const parent = definition.parent ? resolve(definition.parent) : null
    const parentPosition = parent?.position || addVectors(objectPosition, rotateVector(scaleVector(root, objectScale), objectRotation))
    const parentRotation = parent?.rotation || objectRotation
    const localPosition = scaleVector(definition.position, objectScale)
    const position = addVectors(parentPosition, rotateVector(localPosition, parentRotation))
    const localRotation = quaternionFromEulerXYZ(vector3(rig.joints[jointId]))
    const rotation = multiplyQuaternions(parentRotation, localRotation)
    const transform = { position, rotation }
    transforms.set(jointId, transform)
    return transform
  }

  for (const { jointId } of OPENPOSE_JOINT_MAPPING) resolve(jointId)
  return transforms
}

function projectPoint(point, camera, width, height) {
  const cameraPosition = vector3(camera?.position)
  const cameraRotation = quaternionFromEulerXYZ(vector3(camera?.rotation))
  const cameraPoint = rotateVector(point.map((value, index) => value - cameraPosition[index]), invertQuaternion(cameraRotation))
  const depth = -cameraPoint[2]
  if (!(depth > 0)) return { x: 0, y: 0, visible: false }

  const focalLength = Math.max(1, finite(Number(camera?.focalLength)) || 50)
  const aspect = parseAspect(camera?.aspectRatio, width / height)
  const sensorWidth = 36
  const sensorHeight = sensorWidth / aspect
  const ndcX = (cameraPoint[0] * focalLength) / (depth * sensorWidth / 2)
  const ndcY = (cameraPoint[1] * focalLength) / (depth * sensorHeight / 2)
  const visible = Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1
  const x = Math.min(width, Math.max(0, (ndcX + 1) * width / 2))
  const y = Math.min(height, Math.max(0, (1 - ndcY) * height / 2))
  return { x, y, visible }
}

function parseAspect(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const [left, right] = value.split(':').map(Number)
    if (Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0) return left / right
  }
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1
}

export function clampDepth(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function projectPoseKeypoints({ object, camera, width, height, worldJointPositions }) {
  const outputWidth = Math.max(1, Math.round(finite(Number(width))))
  const outputHeight = Math.max(1, Math.round(finite(Number(height))))
  const transforms = worldJointTransforms(object)

  return OPENPOSE_JOINT_MAPPING.map(({ name, jointId, offset }) => {
    const transform = transforms.get(jointId)
    const suppliedPosition = worldJointPositions?.[jointId]
    const livePosition = Array.isArray(suppliedPosition) && suppliedPosition.length >= 3 ? vector3(suppliedPosition) : null
    if (!transform && !livePosition) return { name, x: 0, y: 0, visible: false }
    const point = livePosition || addVectors(transform.position, rotateVector(vector3(offset), transform.rotation))
    return { name, ...projectPoint(point, camera, outputWidth, outputHeight) }
  })
}
