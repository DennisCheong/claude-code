import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import * as React from 'react'
import { BashModeProgress } from 'src/components/BashModeProgress.js'
import type { SetToolJSXFn } from 'src/Tool.js'
import type {
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import { getActiveRemoteWorkspaceSession } from '../../ssh/remoteWorkspaceState.js'
import { errorMessage } from '../errors.js'
import {
  createSyntheticUserCaveatMessage,
  createUserMessage,
  prepareUserContent,
} from '../messages.js'
import { escapeXml } from '../xml.js'
import type { ProcessUserInputContext } from './processUserInput.js'

export async function processRemoteBashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
): Promise<{
  messages: (UserMessage | AttachmentMessage | SystemMessage)[]
  shouldQuery: boolean
}> {
  const session = getActiveRemoteWorkspaceSession()
  const userMessage = createUserMessage({
    content: prepareUserContent({
      inputString: `<bash-input>#${inputString}</bash-input>`,
      precedingInputBlocks,
    }),
  })

  setToolJSX({
    jsx: (
      <BashModeProgress
        input={`#${inputString}`}
        progress={null}
        verbose={context.options.verbose}
      />
    ),
    shouldHidePromptInput: false,
  })

  try {
    if (!session) {
      throw new Error('No active SSH workspace session is attached.')
    }

    const result = await session.runShell(inputString)

    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stdout>${escapeXml(result.stdout)}</bash-stdout><bash-stderr>${escapeXml(result.stderr)}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    }
  } catch (error) {
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stderr>Remote command failed: ${escapeXml(errorMessage(error))}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    }
  } finally {
    setToolJSX(null)
  }
}