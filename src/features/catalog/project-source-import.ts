export const PROJECT_SOURCE_IMPORT_MAX_BYTES = 2_000_000

const SUPPORTED_SOURCE_FILE = /^[^/\\\u0000-\u001f\u007f]{1,255}\.(?:txt|md)$/iu
const SUPPORTED_SOURCE_MIME = new Set([
  '',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
])

export interface ProjectSourceImport {
  fileName: string
  content: string
}

export async function readProjectSourceImport(file: File): Promise<ProjectSourceImport> {
  if (!SUPPORTED_SOURCE_FILE.test(file.name)) {
    throw new Error('只支持 .txt 或 .md 原著文件')
  }
  if (!SUPPORTED_SOURCE_MIME.has(file.type.toLocaleLowerCase())) {
    throw new Error('文件类型不是纯文本或 Markdown')
  }
  if (file.size < 1 || file.size > PROJECT_SOURCE_IMPORT_MAX_BYTES) {
    throw new Error('原著文件必须大于 0 字节且不超过 2MB')
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    throw new Error('原著文件必须是有效 UTF-8 编码')
  }
  if (content.startsWith('\ufeff')) content = content.slice(1)
  return { fileName: file.name, content }
}
