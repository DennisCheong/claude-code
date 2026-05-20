import { posix as posixPath } from 'path'

import type { MemoryFileInfo } from '../utils/claudemd.js'
import { parseMemoryFileContent } from '../utils/claudemd.js'
import type { RemoteWorkspaceSession } from './createSSHSession.js'

async function readRemoteMemoryFile(
  session: RemoteWorkspaceSession,
  remotePath: string,
): Promise<MemoryFileInfo | null> {
  const stats = await session.statPath(remotePath)
  if (!stats.exists || stats.kind !== 'file') {
    return null
  }

  const rawContent = (await session.readTextFile(remotePath)).content
  if (!rawContent.trim()) {
    return null
  }

  const { info } = parseMemoryFileContent(
    rawContent,
    session.toPathToken(remotePath),
    'Project',
  )

  if (!info || !info.content.trim()) {
    return null
  }

  return info
}

export async function getRemoteProjectMemoryFiles(
  session: RemoteWorkspaceSession,
): Promise<MemoryFileInfo[]> {
  const memoryFiles: MemoryFileInfo[] = []
  const remoteClaudeMd = posixPath.join(session.remoteRoot, '.claude', 'CLAUDE.md')
  const claudeMd = await readRemoteMemoryFile(session, remoteClaudeMd)

  if (claudeMd) {
    memoryFiles.push(claudeMd)
  }

  const remoteRuleFiles = await session.findMarkdownFiles(
    posixPath.join(session.remoteRoot, '.claude', 'rules'),
  )

  for (const remoteRuleFile of remoteRuleFiles) {
    const memoryFile = await readRemoteMemoryFile(session, remoteRuleFile)
    if (!memoryFile || memoryFile.globs) {
      continue
    }

    memoryFiles.push(memoryFile)
  }

  return memoryFiles
}