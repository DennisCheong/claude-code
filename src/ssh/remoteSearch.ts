import { posix as posixPath } from 'path'

import picomatch from 'picomatch'

import type { RemoteWorkspaceSession } from './createSSHSession.js'

export function filterRemoteFilesByGlob(
  session: RemoteWorkspaceSession,
  basePath: string,
  files: string[],
  pattern: string | undefined,
): string[] {
  if (!pattern) {
    return files
  }

  const matcher = picomatch(pattern, { dot: true })
  return files.filter(filePath => {
    if (pattern.startsWith('/')) {
      return matcher(filePath)
    }

    const relativePath = posixPath.relative(basePath, filePath)
    return matcher(relativePath)
  })
}

export async function sortRemoteFilesByMtime(
  session: RemoteWorkspaceSession,
  files: string[],
): Promise<string[]> {
  const withStats = await Promise.all(
    files.map(async filePath => ({
      filePath,
      mtimeMs: (await session.statPath(filePath)).mtimeMs ?? 0,
    })),
  )

  return withStats
    .sort((a, b) => {
      const timeComparison = b.mtimeMs - a.mtimeMs
      if (timeComparison === 0) {
        return a.filePath.localeCompare(b.filePath)
      }
      return timeComparison
    })
    .map(entry => entry.filePath)
}
