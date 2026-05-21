import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'

export const CLAUDE_CONFIG_FILE_NAME = 'claude-config.json'

export type ClaudeProvider =
  | 'claude'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai-compatible'

type ClaudeConfigFile = {
  provider?: unknown
  models?: unknown
  env?: Record<string, unknown>
  debug?: unknown
  debugLog?: unknown
  sessionDebug?: unknown
}

type ClaudeConfigDebug = {
  enabled?: unknown
  fullSession?: unknown
  logSessions?: unknown
  logConversations?: unknown
  logToolCalls?: unknown
  level?: unknown
  logLevel?: unknown
  logsDir?: unknown
  logDir?: unknown
}

type ClaudeConfigModelCapabilities = {
  tools?: unknown
  toolcall?: unknown
  toolCall?: unknown
  vision?: unknown
  attachment?: unknown
  temperature?: unknown
  thinking?: unknown
  reasoning?: unknown
  adaptiveThinking?: unknown
  effort?: unknown
  maxEffort?: unknown
  interleavedThinking?: unknown
  interleaved?: unknown
  structuredOutputs?: unknown
  structuredOutput?: unknown
  webFetch?: unknown
  webSearch?: unknown
  input?: unknown
  output?: unknown
}

type ClaudeConfigModel = {
  modelId?: unknown
  provider?: unknown
  name?: unknown
  capabilities?: unknown
  contextWindow?: unknown
  maxInput?: unknown
  maxOutput?: unknown
  limit?: unknown
  supportsTools?: unknown
  supportsVision?: unknown
}

type ClaudeConfigModelLimit = {
  context?: unknown
  input?: unknown
  output?: unknown
}

type ClaudeConfigModelModalities = {
  text?: unknown
  audio?: unknown
  image?: unknown
  video?: unknown
  pdf?: unknown
}

export type ClaudeConfigModelCapability =
  | 'tools'
  | 'vision'
  | 'temperature'
  | 'thinking'
  | 'adaptiveThinking'
  | 'effort'
  | 'maxEffort'
  | 'interleavedThinking'
  | 'structuredOutputs'
  | 'webFetch'
  | 'webSearch'
  | 'inputText'
  | 'inputAudio'
  | 'inputImage'
  | 'inputVideo'
  | 'inputPdf'
  | 'outputText'
  | 'outputAudio'
  | 'outputImage'
  | 'outputVideo'
  | 'outputPdf'

export type ResolvedClaudeConfigModelCapabilities = Partial<
  Record<ClaudeConfigModelCapability, boolean>
>

export type ResolvedClaudeConfigModel = {
  modelId: string
  provider: ClaudeProvider
  name?: string
  capabilities: ResolvedClaudeConfigModelCapabilities
  contextWindow?: number
  maxInput?: number
  maxOutput?: number
}

export type ResolvedClaudeConfigModelSelection = {
  opusModel: ResolvedClaudeConfigModel | null
  sonnetModel: ResolvedClaudeConfigModel | null
  haikuModel: ResolvedClaudeConfigModel | null
  activeProvider: ClaudeProvider | null
  warnings: string[]
}

let cachedConfigEnv: Record<string, string> | null = null
let cachedConfigModels: ResolvedClaudeConfigModel[] | null = null

function warnInvalidConfig(message: string): void {
  process.stderr.write(`${message}\n`)
}

function emitWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    warnInvalidConfig(warning)
  }
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalizedValue = value.trim()
  return normalizedValue === '' ? undefined : normalizedValue
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeConfigBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'string') {
    return undefined
  }
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return undefined
  }
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : NaN
  if (
    !Number.isInteger(numericValue) ||
    numericValue <= 0 ||
    !Number.isSafeInteger(numericValue)
  ) {
    return undefined
  }
  return numericValue
}

function normalizeCapabilityModalities(
  value: unknown,
): ClaudeConfigModelModalities | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ClaudeConfigModelModalities)
    : null
}

function normalizeModelCapabilities(
  model: ClaudeConfigModel,
): ResolvedClaudeConfigModelCapabilities {
  const rawCapabilities =
    model.capabilities &&
    typeof model.capabilities === 'object' &&
    !Array.isArray(model.capabilities)
      ? (model.capabilities as ClaudeConfigModelCapabilities)
      : null
  const inputModalities = normalizeCapabilityModalities(rawCapabilities?.input)
  const outputModalities = normalizeCapabilityModalities(rawCapabilities?.output)

  const normalizedCapabilities: ResolvedClaudeConfigModelCapabilities = {}
  const capabilitySources: Record<ClaudeConfigModelCapability, unknown> = {
    tools:
      rawCapabilities?.tools ??
      rawCapabilities?.toolcall ??
      rawCapabilities?.toolCall ??
      model.supportsTools,
    vision:
      rawCapabilities?.vision ??
      rawCapabilities?.attachment ??
      inputModalities?.image ??
      model.supportsVision,
    temperature: rawCapabilities?.temperature,
    thinking: rawCapabilities?.thinking ?? rawCapabilities?.reasoning,
    adaptiveThinking: rawCapabilities?.adaptiveThinking,
    effort: rawCapabilities?.effort,
    maxEffort: rawCapabilities?.maxEffort,
    interleavedThinking:
      rawCapabilities?.interleavedThinking ?? rawCapabilities?.interleaved,
    structuredOutputs:
      rawCapabilities?.structuredOutputs ?? rawCapabilities?.structuredOutput,
    webFetch: rawCapabilities?.webFetch,
    webSearch: rawCapabilities?.webSearch,
    inputText: inputModalities?.text,
    inputAudio: inputModalities?.audio,
    inputImage: inputModalities?.image,
    inputVideo: inputModalities?.video,
    inputPdf: inputModalities?.pdf,
    outputText: outputModalities?.text,
    outputAudio: outputModalities?.audio,
    outputImage: outputModalities?.image,
    outputVideo: outputModalities?.video,
    outputPdf: outputModalities?.pdf,
  }

  for (const [capability, value] of Object.entries(capabilitySources) as Array<
    [ClaudeConfigModelCapability, unknown]
  >) {
    const normalizedValue = normalizeBoolean(value)
    if (normalizedValue !== undefined) {
      normalizedCapabilities[capability] = normalizedValue
    }
  }

  return normalizedCapabilities
}

function normalizeModelLimit(model: ClaudeConfigModel): {
  contextWindow?: number
  maxInput?: number
  maxOutput?: number
} {
  const rawLimit =
    model.limit && typeof model.limit === 'object' && !Array.isArray(model.limit)
      ? (model.limit as ClaudeConfigModelLimit)
      : null

  return {
    contextWindow: normalizePositiveInteger(
      model.contextWindow ?? rawLimit?.context,
    ),
    maxInput: normalizePositiveInteger(model.maxInput ?? rawLimit?.input),
    maxOutput: normalizePositiveInteger(model.maxOutput ?? rawLimit?.output),
  }
}

function parseConfigProvider(provider: unknown): ClaudeProvider | null {
  const normalizedProvider = normalizeNonEmptyString(provider)?.toLowerCase()
  switch (normalizedProvider) {
    case 'claude':
    case 'bedrock':
    case 'vertex':
    case 'foundry':
    case 'openai-compatible':
      return normalizedProvider
    default:
      return null
  }
}

function resolveConfigProvider(
  provider: unknown,
  source: string,
  warnings: string[],
): ClaudeProvider | null {
  const normalizedProvider = normalizeNonEmptyString(provider)
  if (!normalizedProvider) {
    return null
  }

  const parsedProvider = parseConfigProvider(normalizedProvider)
  if (parsedProvider) {
    return parsedProvider
  }

  warnings.push(
    `Ignoring unsupported provider in ${CLAUDE_CONFIG_FILE_NAME} at ${source}: ${provider}`,
  )
  return null
}

function normalizeConfigProvider(provider: unknown): Record<string, string> {
  const warnings: string[] = []
  const normalizedProvider = resolveConfigProvider(provider, 'provider', warnings)
  emitWarnings(warnings)
  if (!normalizedProvider) {
    return {}
  }

  switch (normalizedProvider) {
    case 'claude':
      return {
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CODE_USE_OPENAI_COMPATIBLE: '0',
      }
    case 'bedrock':
      return {
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CODE_USE_OPENAI_COMPATIBLE: '0',
      }
    case 'vertex':
      return {
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CODE_USE_OPENAI_COMPATIBLE: '0',
      }
    case 'foundry':
      return {
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '1',
        CLAUDE_CODE_USE_OPENAI_COMPATIBLE: '0',
      }
    case 'openai-compatible':
      return {
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CODE_USE_OPENAI_COMPATIBLE: '1',
      }
  }
}

export function normalizeClaudeConfigModels(models: unknown): {
  models: ResolvedClaudeConfigModel[]
  warnings: string[]
} {
  const warnings: string[] = []
  if (!Array.isArray(models)) {
    return { models: [], warnings }
  }

  const normalizedModels: ResolvedClaudeConfigModel[] = []
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index] as ClaudeConfigModel
    const modelId = normalizeNonEmptyString(model?.modelId)
    if (!modelId) {
      continue
    }

    const provider = resolveConfigProvider(
      model.provider,
      `models.${index}.provider`,
      warnings,
    )
    if (!provider) {
      warnings.push(
        `Ignoring model in ${CLAUDE_CONFIG_FILE_NAME} at models.${index}: ${modelId} is missing a supported provider`,
      )
      continue
    }

    const name = normalizeNonEmptyString(model.name)
    const limit = normalizeModelLimit(model)
    normalizedModels.push({
      modelId,
      provider,
      ...(name ? { name } : {}),
      capabilities: normalizeModelCapabilities(model),
      ...limit,
    })
  }

  return { models: normalizedModels, warnings }
}

function loadClaudeConfigModels(): ResolvedClaudeConfigModel[] {
  const candidate = findClaudeConfigFilePath()
  if (!candidate) {
    return []
  }

  try {
    const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as ClaudeConfigFile
    const { models, warnings } = normalizeClaudeConfigModels(parsed.models)
    emitWarnings(warnings)
    return models
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `Failed to parse ${CLAUDE_CONFIG_FILE_NAME} at ${candidate}: ${message}\n`,
    )
    return []
  }
}

export function getClaudeConfigModels(): ResolvedClaudeConfigModel[] {
  if (cachedConfigModels === null) {
    cachedConfigModels = loadClaudeConfigModels()
  }

  return cachedConfigModels
}

function normalizeModelLookupKey(model: string): string {
  return model.toLowerCase().replace(/\[1m\]/gi, '').trim()
}

function findConfiguredModelById(
  models: readonly ResolvedClaudeConfigModel[],
  modelId: string,
): ResolvedClaudeConfigModel | null {
  const modelKey = normalizeModelLookupKey(modelId)

  return (
    models.find(configuredModel => {
      const configuredKey = normalizeModelLookupKey(configuredModel.modelId)
      return (
        configuredKey === modelKey ||
        modelKey.includes(configuredKey) ||
        configuredKey.includes(modelKey)
      )
    }) ?? null
  )
}

function resolveConfiguredDefaultModel(
  models: readonly ResolvedClaudeConfigModel[],
  env: Record<string, unknown> | undefined,
  envKey:
    | 'ANTHROPIC_DEFAULT_OPUS_MODEL'
    | 'ANTHROPIC_DEFAULT_SONNET_MODEL'
    | 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  warnings: string[],
): ResolvedClaudeConfigModel | null {
  const configuredModelId = normalizeNonEmptyString(env?.[envKey])
  if (!configuredModelId) {
    return null
  }

  const configuredModel = findConfiguredModelById(models, configuredModelId)
  if (configuredModel) {
    return configuredModel
  }

  warnings.push(
    `Ignoring ${envKey} in ${CLAUDE_CONFIG_FILE_NAME}: ${configuredModelId} is not defined under models`,
  )
  return null
}

export function getClaudeConfigModel(
  model: string,
): ResolvedClaudeConfigModel | undefined {
  return findConfiguredModelById(getClaudeConfigModels(), model) ?? undefined
}

export function getClaudeConfigModelCapabilityOverride(
  model: string,
  capability: ClaudeConfigModelCapability,
): boolean | undefined {
  return getClaudeConfigModel(model)?.capabilities[capability]
}

export function resolveClaudeConfigModelSelection(
  models: readonly ResolvedClaudeConfigModel[],
  env?: Record<string, unknown>,
): ResolvedClaudeConfigModelSelection {
  const warnings: string[] = []
  if (models.length === 0) {
    return {
      opusModel: null,
      sonnetModel: null,
      haikuModel: null,
      activeProvider: null,
      warnings,
    }
  }

  const configuredOpusModel = resolveConfiguredDefaultModel(
    models,
    env,
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    warnings,
  )
  const configuredSonnetModel = resolveConfiguredDefaultModel(
    models,
    env,
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    warnings,
  )
  const configuredHaikuModel = resolveConfiguredDefaultModel(
    models,
    env,
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    warnings,
  )

  const fallbackModel =
    configuredSonnetModel ?? configuredOpusModel ?? configuredHaikuModel ?? null
  const opusModel = configuredOpusModel ?? fallbackModel
  const sonnetModel = configuredSonnetModel ?? fallbackModel
  const haikuModel = configuredHaikuModel ?? fallbackModel

  const selectedModels = [sonnetModel, opusModel, haikuModel].filter(
    (model): model is ResolvedClaudeConfigModel => model !== null,
  )
  const activeProvider = selectedModels[0]?.provider ?? null

  if (activeProvider) {
    const conflictingModels = selectedModels.filter(
      model => model.provider !== activeProvider,
    )
    if (conflictingModels.length > 0) {
      warnings.push(
        `Configured default models in ${CLAUDE_CONFIG_FILE_NAME} span multiple providers; provider selection uses ${activeProvider} based on ${selectedModels[0].modelId}`,
      )
    }
  }

  return {
    opusModel,
    sonnetModel,
    haikuModel,
    activeProvider,
    warnings,
  }
}

function normalizeConfiguredModels(
  models: unknown,
  env: Record<string, unknown> | undefined,
): Record<string, string> {
  const { models: configuredModels, warnings: modelWarnings } =
    normalizeClaudeConfigModels(models)
  const { activeProvider, warnings: selectionWarnings } =
    resolveClaudeConfigModelSelection(configuredModels, env)

  emitWarnings(modelWarnings)
  emitWarnings(selectionWarnings)

  if (!activeProvider) {
    return {}
  }

  return normalizeConfigProvider(activeProvider)
}

function normalizeConfigEnv(
  env: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!env) {
    return {}
  }

  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      const normalizedValue = String(value)
      if (normalizedValue.trim() === '') {
        continue
      }
      normalized[key] = normalizedValue
    }
  }

  return normalized
}

function normalizeDebugLogLevel(value: unknown): string | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase()
  switch (normalized) {
    case 'verbose':
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return normalized
    default:
      return undefined
  }
}

function normalizeDebugConfig(config: ClaudeConfigFile): Record<string, string> {
  const env: Record<string, string> = {}
  const debugObject =
    config.debug && typeof config.debug === 'object' && !Array.isArray(config.debug)
      ? (config.debug as ClaudeConfigDebug)
      : null

  const legacyDebugLog = normalizeConfigBoolean(config.debugLog)
  const legacySessionDebug = normalizeConfigBoolean(config.sessionDebug)
  const debugEnabled =
    normalizeConfigBoolean(config.debug) ??
    normalizeConfigBoolean(debugObject?.enabled) ??
    legacyDebugLog
  const fullSessionDebug =
    debugEnabled === true ||
    legacySessionDebug === true ||
    legacyDebugLog === true ||
    normalizeConfigBoolean(debugObject?.fullSession) === true ||
    normalizeConfigBoolean(debugObject?.logSessions) === true ||
    normalizeConfigBoolean(debugObject?.logConversations) === true ||
    normalizeConfigBoolean(debugObject?.logToolCalls) === true

  if (debugEnabled === true || fullSessionDebug === true) {
    env.DEBUG = '1'
  }
  if (fullSessionDebug === true) {
    env.CLAUDE_CODE_FULL_SESSION_DEBUG = '1'
    env.CLAUDE_CODE_SESSION_DEBUG_LOG = '1'
    env.CLAUDE_CODE_DEBUG_LOG_LEVEL = 'verbose'
  }

  const configuredLevel = normalizeDebugLogLevel(
    debugObject?.level ?? debugObject?.logLevel,
  )
  if (configuredLevel) {
    env.CLAUDE_CODE_DEBUG_LOG_LEVEL = configuredLevel
  }

  const logsDir = normalizeNonEmptyString(
    debugObject?.logsDir ?? debugObject?.logDir,
  )
  if (logsDir) {
    env.CLAUDE_CODE_DEBUG_LOGS_DIR = logsDir
  }

  return env
}

function getClaudeConfigCandidates(): string[] {
  const entryPath = process.argv[1]
  const candidates: string[] = []
  const addCandidate = (candidate: string): void => {
    const resolved = resolve(candidate)
    if (!candidates.includes(resolved)) {
      candidates.push(resolved)
    }
  }

  let currentDir = resolve(process.cwd())

  for (let depth = 0; depth < 4; depth += 1) {
    addCandidate(resolve(currentDir, CLAUDE_CONFIG_FILE_NAME))
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  if (!entryPath) {
    return candidates
  }

  currentDir = dirname(resolve(entryPath))

  for (let depth = 0; depth < 3; depth += 1) {
    addCandidate(resolve(currentDir, CLAUDE_CONFIG_FILE_NAME))
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  return candidates
}

export function findClaudeConfigFilePath(): string | null {
  return (
    getClaudeConfigCandidates().find(candidate => existsSync(candidate)) ?? null
  )
}

function loadClaudeConfigEnvironmentVariables(): Record<string, string> {
  const candidate = findClaudeConfigFilePath()
  if (!candidate) {
    return {}
  }

  try {
    const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as ClaudeConfigFile

    return {
      ...normalizeConfigProvider(parsed.provider),
      ...normalizeConfiguredModels(parsed.models, parsed.env),
      ...normalizeDebugConfig(parsed),
      ...normalizeConfigEnv(parsed.env),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `Failed to parse ${CLAUDE_CONFIG_FILE_NAME} at ${candidate}: ${message}\n`,
    )
    return {}
  }
}

export function getClaudeConfigEnvironmentVariables(): Record<string, string> {
  if (cachedConfigEnv === null) {
    cachedConfigEnv = loadClaudeConfigEnvironmentVariables()
  }

  return cachedConfigEnv
}

export function resetClaudeConfigEnvironmentVariablesCache(): void {
  cachedConfigEnv = null
  cachedConfigModels = null
}

export function applyClaudeConfigEnvironmentVariables(): void {
  Object.assign(process.env, getClaudeConfigEnvironmentVariables())
}