export type OpenAICompatibleReasoningObject = {
  text?: OpenAICompatibleReasoningValue
  content?: OpenAICompatibleReasoningValue
  thinking?: OpenAICompatibleReasoningValue
  reasoning?: OpenAICompatibleReasoningValue
  reasoning_text?: OpenAICompatibleReasoningValue
  reasoning_content?: OpenAICompatibleReasoningValue
  signature?: string | null
  id?: string | null
  metadata?: Record<string, unknown> | null
}

export type OpenAICompatibleReasoningValue =
  | string
  | null
  | OpenAICompatibleReasoningObject

export type NormalizedOpenAICompatibleReasoning = {
  text?: string
  signature?: string
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function extractReasoningText(
  value: OpenAICompatibleReasoningValue | undefined,
  depth = 0,
): string | undefined {
  if (depth > 4) {
    return undefined
  }

  const directText = getNonEmptyString(value)
  if (directText) {
    return directText
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return (
    extractReasoningText(value.text, depth + 1) ||
    extractReasoningText(value.reasoning_text, depth + 1) ||
    extractReasoningText(value.reasoning_content, depth + 1) ||
    extractReasoningText(value.thinking, depth + 1) ||
    extractReasoningText(value.reasoning, depth + 1) ||
    extractReasoningText(value.content, depth + 1)
  )
}

function extractReasoningSignature(
  value: OpenAICompatibleReasoningValue | undefined,
  depth = 0,
): string | undefined {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return (
    getNonEmptyString(value.signature) ||
    extractReasoningSignature(value.reasoning_content, depth + 1) ||
    extractReasoningSignature(value.thinking, depth + 1) ||
    extractReasoningSignature(value.reasoning, depth + 1)
  )
}

export function normalizeOpenAICompatibleReasoning(
  ...values: Array<OpenAICompatibleReasoningValue | undefined>
): NormalizedOpenAICompatibleReasoning {
  let text: string | undefined
  let signature: string | undefined

  for (const value of values) {
    text ||= extractReasoningText(value)
    signature ||= extractReasoningSignature(value)
  }

  return {
    ...(text ? { text } : {}),
    ...(signature ? { signature } : {}),
  }
}