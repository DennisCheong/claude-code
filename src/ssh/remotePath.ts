import { SSHSessionError, type RemoteWorkspaceSession } from './createSSHSession.js'
import { getActiveRemoteWorkspaceSession } from './remoteWorkspaceState.js'

export function isRemotePathToken(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.startsWith('$')
}

export function stripRemotePathToken(value: string): string {
  return value.slice(1)
}

export function getRemoteWorkspaceForPath(value: string): {
  session: RemoteWorkspaceSession
  remotePath: string
  tokenPath: string
} | null {
  if (!isRemotePathToken(value)) {
    return null
  }

  const session = getActiveRemoteWorkspaceSession()
  if (!session) {
    return null
  }

  const remotePath = session.resolveRemotePath(stripRemotePathToken(value))
  return {
    session,
    remotePath,
    tokenPath: session.toPathToken(remotePath),
  }
}

export function requireRemoteWorkspaceForPath(value: string): {
  session: RemoteWorkspaceSession
  remotePath: string
  tokenPath: string
} {
  const resolved = getRemoteWorkspaceForPath(value)
  if (!resolved) {
    throw new SSHSessionError(
      'Remote path requested, but no active SSH workspace session is attached.',
    )
  }

  return resolved
}
