import type {
  BetaContentBlock,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getSessionId } from 'src/bootstrap/state.js'
import {
  getAIOnlyProxyConfig,
  logAIOnlyProxyDebug,
} from 'src/utils/aiProxyConfig.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { getUserAgent } from 'src/utils/http.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { CLIENT_REQUEST_ID_HEADER } from './client.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import {
  normalizeOpenAICompatibleReasoning,
  type OpenAICompatibleReasoningValue,
} from './openaiCompatibleReasoning.js'

type OpenAICompatibleMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<Record<string, unknown>> | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

type OpenAICompatibleUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
}

type OpenAICompatibleReasoningEffort = 'low' | 'medium' | 'high'

type OpenAICompatibleChoiceDelta = {
  content?: string | Array<{ type?: string; text?: string }> | null
  reasoning_text?: OpenAICompatibleReasoningValue
  reasoning_content?: OpenAICompatibleReasoningValue
  reasoning?: OpenAICompatibleReasoningValue
  thinking?: OpenAICompatibleReasoningValue
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

type OpenAICompatibleChunk = {
  id?: string
  model?: string
  choices?: Array<{
    delta?: OpenAICompatibleChoiceDelta
    finish_reason?: string | null
  }>
  usage?: OpenAICompatibleUsage
}

type OpenAICompatibleResponse = {
  id?: string
  model?: string
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
      reasoning_text?: OpenAICompatibleReasoningValue
      reasoning_content?: OpenAICompatibleReasoningValue
      reasoning?: OpenAICompatibleReasoningValue
      thinking?: OpenAICompatibleReasoningValue
      tool_calls?: Array<{
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
  usage?: OpenAICompatibleUsage
}

type OpenAICompatibleStream = AsyncIterable<BetaRawMessageStreamEvent> & {
  controller: AbortController
}

type PendingOpenAICompatibleToolCall = {
  blockIndex: number
  id?: string
  name?: string
  argumentsText: string
  emittedArgumentsLength: number
  started: boolean
}

function parseHeaderLines(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!raw) {
    return headers
  }

  for (const line of raw.split(/\n|\r\n/)) {
    if (!line.trim()) {
      continue
    }
    const separator = line.indexOf(':')
    if (separator === -1) {
      continue
    }
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (name) {
      headers[name] = value
    }
  }

  return headers
}

function getOpenAICompatibleBaseUrl(): string {
  return process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1'
}

function getOpenAICompatibleApiKey(explicitApiKey?: string): string {
  const apiKey = explicitApiKey || process.env.OPENAI_COMPATIBLE_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_COMPATIBLE_API_KEY must be set when using the openai-compatible provider',
    )
  }
  return apiKey
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    return undefined
  }
  if (/^(0|false|no|off)$/i.test(normalized)) {
    return false
  }

  return isEnvTruthy(normalized)
}

function normalizeReasoningEffort(
  value: unknown,
): OpenAICompatibleReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
      return normalized
    case 'max':
      return 'high'
    default:
      return undefined
  }
}

function getThinkingReasoningEffort(
  thinking: BetaMessageStreamParams['thinking'] | undefined,
): OpenAICompatibleReasoningEffort | undefined {
  if (!thinking || typeof thinking !== 'object' || !('type' in thinking)) {
    return undefined
  }

  if (thinking.type === 'adaptive') {
    return 'high'
  }

  if (thinking.type !== 'enabled') {
    return undefined
  }

  const budgetTokens = thinking.budget_tokens
  if (typeof budgetTokens !== 'number' || budgetTokens <= 0) {
    return 'medium'
  }
  if (budgetTokens <= 4_096) {
    return 'low'
  }
  if (budgetTokens <= 16_384) {
    return 'medium'
  }
  return 'high'
}

function parseQueryParams(
  raw: string | undefined,
): Array<[string, string]> {
  if (!raw?.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)])
    }
  } catch {
    // Fall back to standard query-string parsing below.
  }

  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
  return Array.from(params.entries())
}

function getOpenAICompatibleStore(): boolean | undefined {
  return parseOptionalBoolean(process.env.OPENAI_COMPATIBLE_STORE)
}

function getOpenAICompatibleReasoningEffort(
  params: BetaMessageStreamParams,
): OpenAICompatibleReasoningEffort | undefined {
  const envEffort = normalizeReasoningEffort(
    process.env.OPENAI_COMPATIBLE_REASONING_EFFORT,
  )
  if (envEffort) {
    return envEffort
  }

  const explicitEffort = normalizeReasoningEffort(
    (params.output_config as { effort?: unknown } | undefined)?.effort,
  )
  if (explicitEffort) {
    return explicitEffort
  }

  return getThinkingReasoningEffort(params.thinking)
}

function getOpenAICompatibleUrl(): string {
  try {
    const url = new URL(getOpenAICompatibleBaseUrl())
    const pathname = url.pathname.replace(/\/$/, '')
    url.pathname = pathname.endsWith('/chat/completions')
      ? pathname || '/chat/completions'
      : `${pathname}/chat/completions`

    for (const [key, value] of parseQueryParams(
      process.env.OPENAI_COMPATIBLE_QUERY_PARAMS,
    )) {
      url.searchParams.set(key, value)
    }

    return url.toString()
  } catch {
    const baseUrl = getOpenAICompatibleBaseUrl().replace(/\/$/, '')
    if (baseUrl.endsWith('/chat/completions')) {
      return baseUrl
    }
    return `${baseUrl}/chat/completions`
  }
}

function getOpenAICompatibleHeaders(apiKey?: string): Headers {
  return new Headers({
    Authorization: `Bearer ${getOpenAICompatibleApiKey(apiKey)}`,
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...parseHeaderLines(process.env.ANTHROPIC_CUSTOM_HEADERS),
    ...parseHeaderLines(process.env.OPENAI_COMPATIBLE_HEADERS),
  })
}

function stringifyContentValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (!item || typeof item !== 'object') {
          return ''
        }
        return String((item as { text?: string }).text ?? '')
      })
      .join('')
  }
  if (value === null || value === undefined) {
    return ''
  }
  return JSON.stringify(value)
}

function convertToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return stringifyContentValue(content)
  }

  const text = content
    .map(item => {
      if (!item || typeof item !== 'object') {
        return ''
      }
      const block = item as { type?: string; text?: string; content?: unknown }
      if (block.type === 'text') {
        return block.text ?? ''
      }
      return stringifyContentValue(block.content)
    })
    .join('\n')
    .trim()

  return text || JSON.stringify(content)
}

function convertAnthropicPartToOpenAIContentPart(
  block: Record<string, unknown>,
): Record<string, unknown> | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return {
      type: 'text',
      text: block.text,
    }
  }

  if (block.type === 'image' && block.source && typeof block.source === 'object') {
    const source = block.source as {
      type?: string
      media_type?: string
      data?: string
      url?: string
    }
    if (source.type === 'base64' && source.media_type && source.data) {
      return {
        type: 'image_url',
        image_url: {
          url: `data:${source.media_type};base64,${source.data}`,
        },
      }
    }
    if (source.type === 'url' && source.url) {
      return {
        type: 'image_url',
        image_url: {
          url: source.url,
        },
      }
    }
  }

  return null
}

function flushBufferedUserContent(
  messages: OpenAICompatibleMessage[],
  parts: Array<Record<string, unknown>>,
): void {
  if (parts.length === 0) {
    return
  }
  const textOnly = parts.every(part => part?.type === 'text')
  messages.push({
    role: 'user',
    content: textOnly
      ? parts.map(part => String(part.text ?? '')).join('')
      : [...parts],
  })
  parts.length = 0
}

function convertAssistantMessageContent(
  content: BetaMessageStreamParams['messages'][number]['content'],
): OpenAICompatibleMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'assistant', content }]
  }

  const textParts: string[] = []
  const toolCalls: NonNullable<OpenAICompatibleMessage['tool_calls']> = []

  for (const rawBlock of content) {
    const block = rawBlock as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
      continue
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id:
          typeof block.id === 'string' && block.id.length > 0
            ? block.id
            : `toolu_${randomUUID()}`,
        type: 'function',
        function: {
          name: String(block.name ?? 'tool'),
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        },
      })
    }
  }

  if (textParts.length === 0 && toolCalls.length === 0) {
    return []
  }

  return [
    {
      role: 'assistant',
      ...(textParts.length > 0
        ? { content: textParts.join('') }
        : toolCalls.length > 0
          ? { content: null }
          : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ]
}

function convertUserMessageContent(
  content: BetaMessageStreamParams['messages'][number]['content'],
): OpenAICompatibleMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }]
  }

  const messages: OpenAICompatibleMessage[] = []
  const bufferedParts: Array<Record<string, unknown>> = []

  for (const rawBlock of content) {
    const block = rawBlock as Record<string, unknown>
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      flushBufferedUserContent(messages, bufferedParts)
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: convertToolResultContent(block.content),
      })
      continue
    }

    const part = convertAnthropicPartToOpenAIContentPart(block)
    if (part) {
      bufferedParts.push(part)
    }
  }

  flushBufferedUserContent(messages, bufferedParts)
  return messages
}

function convertAnthropicMessagesToOpenAI(
  params: BetaMessageStreamParams,
): OpenAICompatibleMessage[] {
  const messages: OpenAICompatibleMessage[] = []
  const systemText = Array.isArray(params.system)
    ? params.system
        .map(block => {
          if (typeof block === 'string') {
            return block
          }
          if (block && typeof block === 'object' && 'text' in block) {
            return String(block.text ?? '')
          }
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    : typeof params.system === 'string'
      ? params.system
      : ''

  if (systemText) {
    messages.push({ role: 'system', content: systemText })
  }

  for (const message of params.messages) {
    if (message.role === 'assistant') {
      messages.push(...convertAssistantMessageContent(message.content))
      continue
    }
    if (message.role === 'user') {
      messages.push(...convertUserMessageContent(message.content))
    }
  }

  return messages
}

function convertToolsToOpenAI(
  tools: BetaMessageStreamParams['tools'] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  const mapped = tools
    .map(tool => {
      const candidate = tool as {
        name?: string
        description?: string
        input_schema?: Record<string, unknown>
        strict?: boolean
      }
      if (!candidate.name || !candidate.input_schema) {
        return null
      }

      return {
        type: 'function',
        function: {
          name: candidate.name,
          description: candidate.description,
          parameters: candidate.input_schema,
          ...(candidate.strict ? { strict: true } : {}),
        },
      }
    })
    .filter((tool): tool is Record<string, unknown> => tool !== null)

  return mapped.length > 0 ? mapped : undefined
}

function convertToolChoiceToOpenAI(
  toolChoice: BetaMessageStreamParams['tool_choice'],
): string | { type: 'function'; function: { name: string } } | undefined {
  if (!toolChoice || typeof toolChoice !== 'object' || !('type' in toolChoice)) {
    return undefined
  }

  switch (toolChoice.type) {
    case 'tool':
      return {
        type: 'function',
        function: {
          name: toolChoice.name,
        },
      }
    case 'any':
      return 'required'
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    default:
      return undefined
  }
}

function convertOutputFormatToOpenAI(
  format: BetaJSONOutputFormat | undefined,
): Record<string, unknown> | undefined {
  if (!format || format.type !== 'json_schema') {
    return undefined
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: 'structured_output',
      strict: true,
      schema: format.schema,
    },
  }
}

function buildOpenAICompatibleBody(
  params: BetaMessageStreamParams,
  stream: boolean,
): Record<string, unknown> {
  const store = getOpenAICompatibleStore()
  const reasoningEffort = getOpenAICompatibleReasoningEffort(params)
  const body: Record<string, unknown> = {
    model: params.model,
    messages: convertAnthropicMessagesToOpenAI(params),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(store !== undefined ? { store } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(typeof params.max_tokens === 'number'
      ? { max_tokens: params.max_tokens }
      : {}),
    ...(typeof params.temperature === 'number'
      ? { temperature: params.temperature }
      : {}),
  }

  const tools = convertToolsToOpenAI(params.tools)
  if (tools) {
    body.tools = tools
  }

  const toolChoice = convertToolChoiceToOpenAI(params.tool_choice)
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice
  }

  const stopSequences = (params as { stop_sequences?: string[] }).stop_sequences
  if (stopSequences && stopSequences.length > 0) {
    body.stop = stopSequences
  }

  const responseFormat = convertOutputFormatToOpenAI(
    (params.output_config as { format?: BetaJSONOutputFormat } | undefined)
      ?.format,
  )
  if (responseFormat) {
    body.response_format = responseFormat
  }

  return body
}

function mapUsage(usage: OpenAICompatibleUsage | undefined): typeof EMPTY_USAGE {
  return {
    ...EMPTY_USAGE,
    input_tokens: usage?.prompt_tokens ?? 0,
    cache_creation_input_tokens:
      usage?.prompt_tokens_details?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
  }
}

function mapFinishReason(reason: string | null | undefined): BetaStopReason | null {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'refusal' as BetaStopReason
    default:
      return null
  }
}

function extractTextDelta(value: OpenAICompatibleChoiceDelta['content']): string {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value.map(part => part.text ?? '').join('')
}

function buildBetaMessage(
  body: OpenAICompatibleResponse,
  model: string,
): BetaMessage {
  const choice = body.choices?.[0]
  const responseMessage = choice?.message
  const content: BetaContentBlock[] = []

  const reasoning = normalizeOpenAICompatibleReasoning(
    responseMessage?.reasoning_text,
    responseMessage?.reasoning_content,
    responseMessage?.reasoning,
    responseMessage?.thinking,
  )
  if (reasoning.text) {
    content.push({
      type: 'thinking',
      thinking: reasoning.text,
      signature: reasoning.signature || '',
    } as BetaContentBlock)
  }

  const text = stringifyContentValue(responseMessage?.content)
  if (text) {
    content.push({
      type: 'text',
      text,
      citations: [],
    } as BetaContentBlock)
  }

  for (const toolCall of responseMessage?.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${randomUUID()}`,
      name: toolCall.function?.name || 'tool',
      input: toolCall.function?.arguments || '{}',
    } as BetaContentBlock)
  }

  return {
    id: body.id || `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: body.model || model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: mapUsage(body.usage),
  } as BetaMessage
}

function getRequestId(
  response: Response,
  fallbackId?: string,
): string | undefined {
  return (
    response.headers.get('x-request-id') ||
    response.headers.get('request-id') ||
    fallbackId ||
    undefined
  )
}

async function parseErrorResponse(response: Response): Promise<never> {
  let details = ''
  try {
    const body = (await response.json()) as {
      error?: { message?: string }
      message?: string
    }
    details = body.error?.message || body.message || ''
  } catch {
    details = await response.text()
  }

  const suffix = details ? `: ${details}` : ''
  throw new Error(`OpenAI-compatible API ${response.status}${suffix}`)
}

function getFetchOptions(
  source: string | undefined,
): Pick<RequestInit, 'keepalive'> & {
  dispatcher?: unknown
  proxy?: string
} {
  const aiOnlyProxyConfig = getAIOnlyProxyConfig()
  if (aiOnlyProxyConfig.enabled) {
    logForDebugging(
      `[AI PROXY] enabled for openai-compatible client via ${aiOnlyProxyConfig.url} source=${source ?? 'unknown'}`,
    )
    logAIOnlyProxyDebug(
      `client_create_openai_compatible proxy=${aiOnlyProxyConfig.url} source=${source ?? 'unknown'} dns_through_proxy=${aiOnlyProxyConfig.dnsThroughProxy} fail_closed=${aiOnlyProxyConfig.failClosed}`,
    )
    return getProxyFetchOptions({
      proxyUrlOverride: aiOnlyProxyConfig.url,
      respectNoProxy: false,
    }) as Pick<RequestInit, 'keepalive'> & {
      dispatcher?: unknown
      proxy?: string
    }
  }

  return getProxyFetchOptions() as Pick<RequestInit, 'keepalive'> & {
    dispatcher?: unknown
    proxy?: string
  }
}

async function openAICompatibleFetch(
  body: Record<string, unknown>,
  options: {
    signal?: AbortSignal
    apiKey?: string
    source?: string
    fetchOverride?: typeof globalThis.fetch
  },
): Promise<Response> {
  const headers = getOpenAICompatibleHeaders(options.apiKey)
  if (!headers.has(CLIENT_REQUEST_ID_HEADER)) {
    headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
  }

  const fetchImpl = options.fetchOverride ?? globalThis.fetch
  return await fetchImpl(getOpenAICompatibleUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
    ...getFetchOptions(options.source),
  } as RequestInit)
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAICompatibleChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    buffer = buffer.replace(/\r\n/g, '\n')

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = event
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('')

      if (data === '[DONE]') {
        return
      }
      if (data) {
        yield JSON.parse(data) as OpenAICompatibleChunk
      }

      boundary = buffer.indexOf('\n\n')
    }

    if (done) {
      break
    }
  }
}

export async function createOpenAICompatibleMessage(
  params: BetaMessageStreamParams,
  options: {
    signal?: AbortSignal
    apiKey?: string
    source?: string
    fetchOverride?: typeof globalThis.fetch
  },
): Promise<{
  message: BetaMessage
  response: Response
  requestId?: string
}> {
  const response = await openAICompatibleFetch(
    buildOpenAICompatibleBody(params, false),
    options,
  )
  if (!response.ok) {
    await parseErrorResponse(response)
  }

  const body = (await response.json()) as OpenAICompatibleResponse
  return {
    message: buildBetaMessage(body, params.model),
    response,
    requestId: getRequestId(response, body.id),
  }
}

export async function createOpenAICompatibleStream(
  params: BetaMessageStreamParams,
  options: {
    signal?: AbortSignal
    apiKey?: string
    source?: string
    fetchOverride?: typeof globalThis.fetch
  },
): Promise<{
  data: OpenAICompatibleStream
  response: Response
  requestId?: string
}> {
  const controller = new AbortController()
  if (options.signal?.aborted) {
    controller.abort(options.signal.reason)
  } else {
    options.signal?.addEventListener(
      'abort',
      () => {
        controller.abort(options.signal?.reason)
      },
      { once: true },
    )
  }

  const response = await openAICompatibleFetch(
    buildOpenAICompatibleBody(params, true),
    {
      ...options,
      signal: controller.signal,
    },
  )
  if (!response.ok) {
    await parseErrorResponse(response)
  }
  if (!response.body) {
    throw new Error('OpenAI-compatible API returned an empty response body')
  }

  const stream: OpenAICompatibleStream = {
    controller,
    async *[Symbol.asyncIterator]() {
      let messageStarted = false
      let messageId = getRequestId(response) || `msg_${randomUUID()}`
      let model = params.model
      let usage = { ...EMPTY_USAGE }
      let textOpen = false
      let thinkingOpen = false
      let textIndex = 0
      let thinkingIndex = 0
      const pendingToolCalls = new Map<number, PendingOpenAICompatibleToolCall>()
      let nextIndex = 0
      let finishReason: BetaStopReason | null = null

      for await (const chunk of parseSSE(response.body!)) {
        model = chunk.model || model
        messageId = chunk.id || messageId
        usage = mapUsage(chunk.usage)

        if (!messageStarted) {
          messageStarted = true
          yield {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage,
            } as BetaMessage,
          } as BetaRawMessageStreamEvent
        }

        const choice = chunk.choices?.[0]
        if (!choice) {
          continue
        }

        const delta = choice.delta ?? {}
        const reasoning = normalizeOpenAICompatibleReasoning(
          delta.reasoning_text,
          delta.reasoning_content,
          delta.reasoning,
          delta.thinking,
        )
        if (reasoning.text) {
          if (textOpen) {
            yield {
              type: 'content_block_stop',
              index: textIndex,
            } as BetaRawMessageStreamEvent
            textOpen = false
          }
          if (!thinkingOpen) {
            thinkingIndex = nextIndex++
            yield {
              type: 'content_block_start',
              index: thinkingIndex,
              content_block: {
                type: 'thinking',
                thinking: '',
                signature: '',
              },
            } as BetaRawMessageStreamEvent
            thinkingOpen = true
          }
          yield {
            type: 'content_block_delta',
            index: thinkingIndex,
            delta: {
              type: 'thinking_delta',
              thinking: reasoning.text,
            },
          } as BetaRawMessageStreamEvent
        }
        if (reasoning.signature && thinkingOpen) {
          yield {
            type: 'content_block_delta',
            index: thinkingIndex,
            delta: {
              type: 'signature_delta',
              signature: reasoning.signature,
            },
          } as BetaRawMessageStreamEvent
        }

        const textDelta = extractTextDelta(delta.content)
        if (textDelta) {
          if (thinkingOpen) {
            yield {
              type: 'content_block_stop',
              index: thinkingIndex,
            } as BetaRawMessageStreamEvent
            thinkingOpen = false
          }
          if (!textOpen) {
            textIndex = nextIndex++
            yield {
              type: 'content_block_start',
              index: textIndex,
              content_block: {
                type: 'text',
                text: '',
                citations: [],
              },
            } as BetaRawMessageStreamEvent
            textOpen = true
          }
          yield {
            type: 'content_block_delta',
            index: textIndex,
            delta: {
              type: 'text_delta',
              text: textDelta,
            },
          } as BetaRawMessageStreamEvent
        }

        if (delta.tool_calls && delta.tool_calls.length > 0) {
          if (thinkingOpen) {
            yield {
              type: 'content_block_stop',
              index: thinkingIndex,
            } as BetaRawMessageStreamEvent
            thinkingOpen = false
          }
          if (textOpen) {
            yield {
              type: 'content_block_stop',
              index: textIndex,
            } as BetaRawMessageStreamEvent
            textOpen = false
          }

          for (const toolCall of delta.tool_calls) {
            const deltaIndex = toolCall.index ?? 0
            const pendingToolCall = pendingToolCalls.get(deltaIndex) ?? {
              blockIndex: nextIndex++,
              argumentsText: '',
              emittedArgumentsLength: 0,
              started: false,
            }

            if (toolCall.id) {
              pendingToolCall.id = toolCall.id
            }
            if (toolCall.function?.name) {
              pendingToolCall.name = toolCall.function.name
            }
            if (toolCall.function?.arguments) {
              pendingToolCall.argumentsText += toolCall.function.arguments
            }

            if (
              !pendingToolCall.started &&
              pendingToolCall.id &&
              pendingToolCall.name
            ) {
              yield {
                type: 'content_block_start',
                index: pendingToolCall.blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: pendingToolCall.id,
                  name: pendingToolCall.name,
                  input: '',
                },
              } as BetaRawMessageStreamEvent
              pendingToolCall.started = true
            }

            const pendingArguments = pendingToolCall.argumentsText.slice(
              pendingToolCall.emittedArgumentsLength,
            )
            if (pendingToolCall.started && pendingArguments) {
              yield {
                type: 'content_block_delta',
                index: pendingToolCall.blockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: pendingArguments,
                },
              } as BetaRawMessageStreamEvent
              pendingToolCall.emittedArgumentsLength =
                pendingToolCall.argumentsText.length
            }

            pendingToolCalls.set(deltaIndex, pendingToolCall)
          }
        }

        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason)
        }
      }

      if (thinkingOpen) {
        yield {
          type: 'content_block_stop',
          index: thinkingIndex,
        } as BetaRawMessageStreamEvent
      }
      if (textOpen) {
        yield {
          type: 'content_block_stop',
          index: textIndex,
        } as BetaRawMessageStreamEvent
      }
      for (const pendingToolCall of [...pendingToolCalls.values()].sort(
        (left, right) => left.blockIndex - right.blockIndex,
      )) {
        if (!pendingToolCall.started) {
          yield {
            type: 'content_block_start',
            index: pendingToolCall.blockIndex,
            content_block: {
              type: 'tool_use',
              id: pendingToolCall.id || `toolu_${randomUUID()}`,
              name: pendingToolCall.name || 'tool',
              input: '',
            },
          } as BetaRawMessageStreamEvent

          const pendingArguments = pendingToolCall.argumentsText.slice(
            pendingToolCall.emittedArgumentsLength,
          )
          if (pendingArguments) {
            yield {
              type: 'content_block_delta',
              index: pendingToolCall.blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: pendingArguments,
              },
            } as BetaRawMessageStreamEvent
          }
        }

        yield {
          type: 'content_block_stop',
          index: pendingToolCall.blockIndex,
        } as BetaRawMessageStreamEvent
      }

      if (!messageStarted) {
        yield {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          } as BetaMessage,
        } as BetaRawMessageStreamEvent
      }

      yield {
        type: 'message_delta',
        delta: {
          stop_reason: finishReason,
          stop_sequence: null,
        },
        usage,
      } as BetaRawMessageStreamEvent

      yield {
        type: 'message_stop',
      } as BetaRawMessageStreamEvent
    },
  }

  return {
    data: stream,
    response,
    requestId: getRequestId(response),
  }
}