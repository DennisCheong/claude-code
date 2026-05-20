import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { getDebugLogPath } from './debug.js'

const NETWORK_CONFIG_FILE_NAME = 'network-config.json'

type AIOnlyProxyConfigFile = {
  enabled?: unknown
  url?: unknown
  'dns-through-proxy'?: unknown
  'fail-closed'?: unknown
  'debug-log'?: unknown
}

type NetworkConfigFile = {
  'ai-only-proxy'?: AIOnlyProxyConfigFile
}

export type AIOnlyProxyConfig = {
  enabled: boolean
  url?: string
  dnsThroughProxy: boolean
  failClosed: boolean
  debugLog: boolean
}

const DEFAULT_AI_ONLY_PROXY_CONFIG: AIOnlyProxyConfig = {
  enabled: false,
  dnsThroughProxy: true,
  failClosed: true,
  debugLog: false,
}

let cachedAIOnlyProxyConfig: AIOnlyProxyConfig | null = null

function getNetworkConfigCandidates(): string[] {
  const entryPath = process.argv[1]
  if (!entryPath) {
    return []
  }

  const candidates: string[] = []
  let currentDir = dirname(resolve(entryPath))

  for (let depth = 0; depth < 3; depth += 1) {
    candidates.push(resolve(currentDir, NETWORK_CONFIG_FILE_NAME))
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  return candidates
}

function getBooleanField(
  fieldName: string,
  value: unknown,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    throw new Error(`ai-only-proxy.${fieldName} must be a boolean`)
  }
  return value
}

function normalizeAIOnlyProxyConfig(
  rawConfig: AIOnlyProxyConfigFile | undefined,
): AIOnlyProxyConfig {
  if (rawConfig === undefined) {
    return DEFAULT_AI_ONLY_PROXY_CONFIG
  }

  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('ai-only-proxy must be an object')
  }

  const enabled = getBooleanField(
    'enabled',
    rawConfig.enabled,
    DEFAULT_AI_ONLY_PROXY_CONFIG.enabled,
  )
  const dnsThroughProxy = getBooleanField(
    'dns-through-proxy',
    rawConfig['dns-through-proxy'],
    DEFAULT_AI_ONLY_PROXY_CONFIG.dnsThroughProxy,
  )
  const failClosed = getBooleanField(
    'fail-closed',
    rawConfig['fail-closed'],
    DEFAULT_AI_ONLY_PROXY_CONFIG.failClosed,
  )
  const debugLog = getBooleanField(
    'debug-log',
    rawConfig['debug-log'],
    DEFAULT_AI_ONLY_PROXY_CONFIG.debugLog,
  )

  let url: string | undefined
  if (rawConfig.url !== undefined) {
    if (typeof rawConfig.url !== 'string' || rawConfig.url.trim() === '') {
      throw new Error('ai-only-proxy.url must be a non-empty string')
    }
    const parsedUrl = new URL(rawConfig.url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('ai-only-proxy.url must use http or https')
    }
    url = parsedUrl.toString()
  }

  if (!enabled) {
    return {
      enabled,
      url,
      dnsThroughProxy,
      failClosed,
      debugLog,
    }
  }

  if (!url) {
    throw new Error('ai-only-proxy.url is required when ai-only-proxy.enabled=true')
  }
  if (!dnsThroughProxy) {
    throw new Error(
      'ai-only-proxy currently requires dns-through-proxy=true',
    )
  }
  if (!failClosed) {
    throw new Error('ai-only-proxy currently requires fail-closed=true')
  }

  return {
    enabled,
    url,
    dnsThroughProxy,
    failClosed,
    debugLog,
  }
}

function loadAIOnlyProxyConfig(): AIOnlyProxyConfig {
  for (const candidate of getNetworkConfigCandidates()) {
    if (!existsSync(candidate)) {
      continue
    }

    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as NetworkConfigFile
      return normalizeAIOnlyProxyConfig(parsed['ai-only-proxy'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to parse ${NETWORK_CONFIG_FILE_NAME} at ${candidate}: ${message}`,
      )
    }
  }

  return DEFAULT_AI_ONLY_PROXY_CONFIG
}

export function getAIOnlyProxyConfig(): AIOnlyProxyConfig {
  if (cachedAIOnlyProxyConfig === null) {
    cachedAIOnlyProxyConfig = loadAIOnlyProxyConfig()
  }

  return cachedAIOnlyProxyConfig
}

export function logAIOnlyProxyDebug(message: string): void {
  let config: AIOnlyProxyConfig
  try {
    config = getAIOnlyProxyConfig()
  } catch {
    return
  }

  if (!config.enabled || !config.debugLog) {
    return
  }

  try {
    const debugLogPath = getDebugLogPath()
    mkdirSync(dirname(debugLogPath), { recursive: true })
    appendFileSync(
      debugLogPath,
      `${new Date().toISOString()} [AI_PROXY] ${message.trim()}\n`,
    )
  } catch {
    // Debug logging must never break the request path.
  }
}