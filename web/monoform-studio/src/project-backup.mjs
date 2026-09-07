const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = value => typeof value === 'string' && value.trim().length > 0
const isVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)

function validateCustomPoses(poses) {
  const invalid = () => { throw new Error('工程文件中的姿势库格式无效，未导入任何数据。') }
  if (!Array.isArray(poses)) invalid()
  const ids = new Set()
  for (const pose of poses) {
    if (!isRecord(pose) || !isText(pose.id) || !isText(pose.name) || ids.has(pose.id)) invalid()
    if (pose.pose !== undefined && !isText(pose.pose)) invalid()
    if (pose.poseTime !== undefined && !Number.isFinite(pose.poseTime)) invalid()
    if (pose.rigRoot !== undefined && !isVector(pose.rigRoot)) invalid()
    if (pose.joints !== undefined && (!isRecord(pose.joints) || !Object.values(pose.joints).every(isVector))) invalid()
    ids.add(pose.id)
  }
}

// Recovery is an explicit file operation; it must include the current in-memory
// library, not only the last acknowledged server values or project snapshots.
export function serializeProjectBackup(project, customPoses) {
  return JSON.stringify({ ...project, customPoses }, null, 2)
}

export function parseProjectBackup(serialized) {
  const data = JSON.parse(serialized)
  if (!isRecord(data) || (!Array.isArray(data.objects) && !Array.isArray(data.shots?.[0]?.objects))) {
    throw new Error('工程文件格式无效。')
  }
  if (Object.hasOwn(data, 'customPoses')) validateCustomPoses(data.customPoses)
  const { customPoses, ...project } = data
  // Missing means preserve the existing library; an explicit [] means restore it empty.
  return { project, customPoses }
}
