export type StreamingThinkingState = {
  thinking: string
  isStreaming: boolean
  streamingEndedAt?: number
}

export function startStreamingThinking(): StreamingThinkingState {
  return {
    thinking: '',
    isStreaming: true,
  }
}

export function appendStreamingThinking(
  current: Pick<StreamingThinkingState, 'thinking'> | null | undefined,
  delta: string,
): StreamingThinkingState {
  return {
    thinking: `${current?.thinking ?? ''}${delta}`,
    isStreaming: true,
  }
}

export function stopStreamingThinking(
  current: StreamingThinkingState | null,
  streamingEndedAt = Date.now(),
): StreamingThinkingState | null {
  if (!current?.isStreaming) {
    return current
  }

  return {
    ...current,
    isStreaming: false,
    streamingEndedAt,
  }
}