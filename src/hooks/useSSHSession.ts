import type React from 'react'
import { useCallback, useMemo } from 'react'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import type { Tool } from '../Tool.js'
import type { Message as MessageType } from '../types/message.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

type UseSSHSessionResult = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

type UseSSHSessionProps = {
  session: SSHSession | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
}

export function useSSHSession({
  session,
}: UseSSHSessionProps): UseSSHSessionResult {
  const isRemoteMode = false

  const sendMessage = useCallback(
    async (_content: RemoteMessageContent): Promise<boolean> => {
      return false
    },
    [],
  )

  const cancelRequest = useCallback(() => {
  }, [])

  const disconnect = useCallback(() => {
    session?.close()
  }, [session])

  return useMemo(
    () => ({ isRemoteMode, sendMessage, cancelRequest, disconnect }),
    [isRemoteMode, sendMessage, cancelRequest, disconnect],
  )
}

