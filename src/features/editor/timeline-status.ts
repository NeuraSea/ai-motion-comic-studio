import type { TimelineStoragePhase } from './manju-storage-adapter'

const DEFAULT_KERNEL_LABEL = 'OpenCut 命令栈已启用'
const LOCAL_KERNEL_LABEL = `${DEFAULT_KERNEL_LABEL} · 本地态`

/**
 * Prevent a stale pre-bootstrap label from contradicting the authoritative
 * persistence phase. Interaction feedback is left untouched.
 */
export function resolveTimelineKernelLabel(
  label: string,
  storagePhase: TimelineStoragePhase,
  hasPersistence: boolean,
): string {
  if (!hasPersistence || (label !== DEFAULT_KERNEL_LABEL && label !== LOCAL_KERNEL_LABEL)) {
    return label
  }
  if (storagePhase === 'loading') {
    return `${DEFAULT_KERNEL_LABEL} · 正在读取修订`
  }
  if (storagePhase === 'missing') {
    return `${DEFAULT_KERNEL_LABEL} · 待首次保存`
  }
  return label
}
