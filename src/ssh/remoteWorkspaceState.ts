import type { RemoteWorkspaceSession } from './createSSHSession.js'

let activeRemoteWorkspaceSession: RemoteWorkspaceSession | null = null

export function getActiveRemoteWorkspaceSession(): RemoteWorkspaceSession | null {
  return activeRemoteWorkspaceSession
}

export function setActiveRemoteWorkspaceSession(
  session: RemoteWorkspaceSession | null,
): void {
  activeRemoteWorkspaceSession = session
}

export function hasActiveRemoteWorkspaceSession(): boolean {
  return activeRemoteWorkspaceSession !== null
}