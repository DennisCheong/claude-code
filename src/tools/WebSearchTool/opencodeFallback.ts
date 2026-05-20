import { getSessionId } from '../../bootstrap/state.js'
import { getDefaultMainLoopModel } from '../../utils/model/model.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import type { Input, Output, SearchResult, WebSearchProgress } from './WebSearchTool.js'

type WebSearchProvider = 'exa' | 'parallel'

type ProgressCallback =
  | ((progress: { toolUseID: string; data: WebSearchProgress }) => void)
  | undefined

const EXA_MCP_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : 'https://mcp.exa.ai/mcp'
const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp'
const DEFAULT_RESULT_COUNT = 8
const DEFAULT_CONTEXT_MAX_CHARACTERS = 10_000
const SEARCH_TIMEOUT_MS = 25_000

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false
  }
  return !/^(0|false|no|off)$/i.test(value.trim())
}

function selectWebSearchProvider(): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === 'exa' || override === 'parallel') {
    return override
  }
  if (isEnvTruthy(process.env.OPENCODE_ENABLE_PARALLEL)) {
    return 'parallel'
  }
  if (isEnvTruthy(process.env.OPENCODE_ENABLE_EXA)) {
    return 'exa'
  }
  if (process.env.PARALLEL_API_KEY && !process.env.EXA_API_KEY) {
    return 'parallel'
  }
  return 'exa'
}

function getProviderLabel(provider: WebSearchProvider): string {
  return provider === 'parallel' ? 'Parallel Web Search' : 'Exa Web Search'
}

function buildProviderQuery(input: Input): string {
  const clauses = [input.query]
  if (input.allowed_domains?.length) {
    clauses.push(
      `(${input.allowed_domains.map(domain => `site:${domain}`).join(' OR ')})`,
    )
  }
  if (input.blocked_domains?.length) {
    clauses.push(
      input.blocked_domains.map(domain => `-site:${domain}`).join(' '),
    )
  }
  return clauses.join(' ')
}

function parseMcpPayload(payload: string): string | undefined {
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{')) {
    return undefined
  }

  const parsed = JSON.parse(trimmed) as {
    result?: { content?: Array<{ type?: string; text?: string }> }
  }
  return parsed.result?.content?.find(item => item.text)?.text
}

function parseMcpResponse(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed) {
    return undefined
  }

  try {
    const direct = parseMcpPayload(trimmed)
    if (direct) {
      return direct
    }
  } catch {
    // Fall back to SSE line parsing below.
  }

  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue
    }
    try {
      const data = parseMcpPayload(line.slice(6))
      if (data) {
        return data
      }
    } catch {
      // Ignore malformed SSE chunks.
    }
  }
  return undefined
}

function createTimeoutSignal(signal: AbortSignal): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error('Web search request timed out'))
  }, SEARCH_TIMEOUT_MS)

  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    },
  }
}

async function callMcpWebSearch(
  provider: WebSearchProvider,
  input: Input,
  signal: AbortSignal,
): Promise<string> {
  const providerQuery = buildProviderQuery(input)
  const body =
    provider === 'parallel'
      ? {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'web_search',
            arguments: {
              objective: providerQuery,
              search_queries: [providerQuery],
              session_id: getSessionId(),
              model_name:
                process.env.OPENAI_COMPATIBLE_MODEL || getDefaultMainLoopModel(),
            },
          },
        }
      : {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: {
              query: providerQuery,
              type: 'auto',
              numResults: DEFAULT_RESULT_COUNT,
              livecrawl: 'fallback',
              contextMaxCharacters: DEFAULT_CONTEXT_MAX_CHARACTERS,
            },
          },
        }

  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  }
  if (provider === 'parallel' && process.env.PARALLEL_API_KEY) {
    headers.Authorization = `Bearer ${process.env.PARALLEL_API_KEY}`
  }

  const timeoutSignal = createTimeoutSignal(signal)
  try {
    const response = await fetch(
      provider === 'parallel' ? PARALLEL_MCP_URL : EXA_MCP_URL,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: timeoutSignal.signal,
        ...getProxyFetchOptions(),
      },
    )
    if (!response.ok) {
      throw new Error(
        `${getProviderLabel(provider)} failed with ${response.status} ${response.statusText}`,
      )
    }

    const text = await response.text()
    return parseMcpResponse(text) ?? text.trim()
  } finally {
    timeoutSignal.cleanup()
  }
}

function extractSearchHits(text: string): SearchResult[] {
  const hits = new Map<string, { title: string; url: string }>()
  const markdownLinkPattern = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g
  const rawUrlPattern = /https?:\/\/[^\s)\]}>"]+/g

  for (const match of text.matchAll(markdownLinkPattern)) {
    const title = match[1]?.trim()
    const url = match[2]?.trim()
    if (title && url && !hits.has(url)) {
      hits.set(url, { title, url })
    }
  }

  for (const match of text.matchAll(rawUrlPattern)) {
    const rawUrl = match[0]?.replace(/[.,;:!?]+$/, '')
    if (rawUrl && !hits.has(rawUrl)) {
      hits.set(rawUrl, { title: rawUrl, url: rawUrl })
    }
  }

  const content = Array.from(hits.values()).slice(0, DEFAULT_RESULT_COUNT)
  return content.length > 0
    ? [{ tool_use_id: 'opencode-websearch', content }]
    : []
}

export async function runOpenCodeWebSearchFallback(
  input: Input,
  abortController: AbortController,
  startTime: number,
  onProgress: ProgressCallback,
): Promise<{ data: Output }> {
  const provider = selectWebSearchProvider()
  onProgress?.({
    toolUseID: 'opencode-websearch-query',
    data: {
      type: 'query_update',
      query: buildProviderQuery(input),
    },
  })

  const text = await callMcpWebSearch(provider, input, abortController.signal)
  const hits = extractSearchHits(text)
  onProgress?.({
    toolUseID: 'opencode-websearch-results',
    data: {
      type: 'search_results_received',
      resultCount: hits[0]?.content.length ?? 0,
      query: input.query,
    },
  })

  const durationSeconds = (performance.now() - startTime) / 1000
  return {
    data: {
      query: input.query,
      results: [
        `${getProviderLabel(provider)} fallback result:\n\n${text || 'No search results found. Please try a different query.'}`,
        ...hits,
      ],
      durationSeconds,
    },
  }
}
