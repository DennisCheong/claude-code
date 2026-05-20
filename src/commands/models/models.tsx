import { readFileSync } from 'fs'
import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import {
  setInitialMainLoopModel,
  setMainLoopModelOverride,
} from '../../bootstrap/state.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  CLAUDE_CONFIG_FILE_NAME,
  findClaudeConfigFilePath,
  normalizeClaudeConfigModels,
  resolveClaudeConfigModelSelection,
  resetClaudeConfigEnvironmentVariablesCache,
} from '../../utils/claudeConfigEnv.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../../utils/file.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { getDefaultMainLoopModel } from '../../utils/model/model.js'
import { reset3PModelCapabilityOverrideCache } from '../../utils/model/modelSupportOverrides.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

type EditableClaudeConfigModel = Record<string, unknown> & {
  modelId?: unknown
  provider?: unknown
  name?: unknown
}

type EditableClaudeConfigFile = Record<string, unknown> & {
  provider?: unknown
  models?: unknown
  env?: Record<string, unknown>
}

type ParsedCommand =
  | { type: 'show' }
  | { type: 'help' }
  | { type: 'set'; target: 'opus' | 'sonnet' | 'haiku' | 'all'; modelId: string }

const MODEL_ENV_KEYS = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
} as const

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalizedValue = value.trim()
  return normalizedValue === '' ? undefined : normalizedValue
}

function parseCommand(args: string): ParsedCommand {
  if (!args || COMMON_INFO_ARGS.includes(args)) {
    return { type: 'show' }
  }

  if (COMMON_HELP_ARGS.includes(args)) {
    return { type: 'help' }
  }

  const parts = args.split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts[0] === 'list') {
    return { type: 'show' }
  }

  if (parts.length === 1) {
    return { type: 'set', target: 'all', modelId: parts[0] }
  }

  if (
    (parts[0] === 'opus' ||
      parts[0] === 'sonnet' ||
      parts[0] === 'haiku' ||
      parts[0] === 'all') &&
    parts[1]
  ) {
    return {
      type: 'set',
      target: parts[0],
      modelId: parts.slice(1).join(' '),
    }
  }

  return { type: 'help' }
}

function getHelpText(): string {
  return [
    `Run ${chalk.bold('/models')} to show the configured Opus, Sonnet, and Haiku models.`,
    `Run ${chalk.bold('/models all <modelId>')} to set all three roles to the same model.`,
    `Run ${chalk.bold('/models opus <modelId>')}, ${chalk.bold('/models sonnet <modelId>')}, or ${chalk.bold('/models haiku <modelId>')} to update one role.`,
  ].join('\n')
}

function readClaudeConfigFile(configPath: string): EditableClaudeConfigFile {
  const parsed = jsonParse(readFileSync(configPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CLAUDE_CONFIG_FILE_NAME} must contain a JSON object`)
  }

  return parsed as EditableClaudeConfigFile
}

function getConfigStatus(config: EditableClaudeConfigFile): {
  models: ReturnType<typeof normalizeClaudeConfigModels>['models']
  opusModelId: string | null
  sonnetModelId: string | null
  haikuModelId: string | null
  activeProvider: string | null
  warnings: string[]
} {
  const { models, warnings } = normalizeClaudeConfigModels(config.models)
  const selection = resolveClaudeConfigModelSelection(models, config.env)

  return {
    models,
    opusModelId: selection.opusModel?.modelId ?? null,
    sonnetModelId: selection.sonnetModel?.modelId ?? null,
    haikuModelId: selection.haikuModel?.modelId ?? null,
    activeProvider: selection.activeProvider ?? null,
    warnings: [...warnings, ...selection.warnings],
  }
}

function formatModelLabel(model: {
  modelId: string
  provider: string
  name?: string
}): string {
  const suffix = model.name ? ` (${model.name})` : ''
  return `${model.modelId}${suffix} [${model.provider}]`
}

function buildStatusMessage(config: EditableClaudeConfigFile): string {
  const { models, opusModelId, sonnetModelId, haikuModelId, activeProvider, warnings } =
    getConfigStatus(config)

  if (models.length === 0) {
    return [
      `${CLAUDE_CONFIG_FILE_NAME} has no usable models.`,
      `Add entries under ${chalk.bold('models')} with ${chalk.bold('modelId')} and ${chalk.bold('provider')}.`,
    ].join('\n')
  }

  const selectedOpus = models.find(model => model.modelId === opusModelId)
  const selectedSonnet = models.find(model => model.modelId === sonnetModelId)
  const selectedHaiku = models.find(model => model.modelId === haikuModelId)

  const lines = [
    `Opus: ${selectedOpus ? chalk.bold(formatModelLabel(selectedOpus)) : 'unset'}`,
    `Sonnet: ${selectedSonnet ? chalk.bold(formatModelLabel(selectedSonnet)) : 'unset'}`,
    `Haiku: ${selectedHaiku ? chalk.bold(formatModelLabel(selectedHaiku)) : 'unset'}`,
    `Active provider: ${activeProvider ? chalk.bold(activeProvider) : 'unset'}`,
    'Available models:',
    ...models.map(model => `- ${formatModelLabel(model)}`),
  ]

  if (warnings.length > 0) {
    lines.push('Warnings:')
    lines.push(...warnings.map(warning => `- ${warning}`))
  }

  lines.push('Usage:')
  lines.push('- /models all <modelId>')
  lines.push('- /models opus <modelId>')
  lines.push('- /models sonnet <modelId>')
  lines.push('- /models haiku <modelId>')

  return lines.join('\n')
}

function stripLegacyRoleFlags(
  models: unknown,
): unknown[] {
  if (!Array.isArray(models)) {
    return []
  }

  return models.map(model => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      return model
    }

    const nextModel = { ...(model as EditableClaudeConfigModel) }
    delete nextModel.isPrimary
    delete nextModel.isSecondary
    return nextModel
  })
}

function setConfiguredDefaultModels(
  env: Record<string, unknown> | undefined,
  target: 'opus' | 'sonnet' | 'haiku' | 'all',
  targetModelId: string,
): Record<string, unknown> {
  const nextEnv: Record<string, unknown> = { ...(env ?? {}) }

  if (target === 'all') {
    for (const envKey of Object.values(MODEL_ENV_KEYS)) {
      nextEnv[envKey] = targetModelId
    }
    return nextEnv
  }

  nextEnv[MODEL_ENV_KEYS[target]] = targetModelId
  return nextEnv
}

function getSelectedProviderCount(status: {
  opusModelId: string | null
  sonnetModelId: string | null
  haikuModelId: string | null
  models: ReturnType<typeof normalizeClaudeConfigModels>['models']
}): number {
  return new Set(
    [status.opusModelId, status.sonnetModelId, status.haikuModelId]
      .map(modelId => status.models.find(model => model.modelId === modelId)?.provider)
      .filter(provider => provider !== undefined),
  ).size
}

function updateConfiguredModels(
  config: EditableClaudeConfigFile,
  target: 'opus' | 'sonnet' | 'haiku' | 'all',
  targetModelId: string,
): {
  nextConfig: EditableClaudeConfigFile
  opusModelId: string
  sonnetModelId: string
  haikuModelId: string
  note?: string
} {
  const nextModels = stripLegacyRoleFlags(config.models)
  const { models: normalizedModels } = normalizeClaudeConfigModels(nextModels)
  const targetModel = normalizedModels.find(model => model.modelId === targetModelId)

  if (!Array.isArray(config.models) || !targetModel) {
    throw new Error(
      `Model '${targetModelId}' was not found in ${CLAUDE_CONFIG_FILE_NAME}.models`,
    )
  }

  let nextEnv = setConfiguredDefaultModels(config.env, target, targetModelId)
  let nextConfig: EditableClaudeConfigFile = {
    ...config,
    env: nextEnv,
    models: nextModels,
  }
  let note: string | undefined
  delete nextConfig.provider

  let status = getConfigStatus(nextConfig)
  if (target !== 'all' && getSelectedProviderCount(status) > 1) {
    nextEnv = setConfiguredDefaultModels(nextEnv, 'all', targetModelId)
    nextConfig = {
      ...config,
      env: nextEnv,
      models: nextModels,
    }
    delete nextConfig.provider
    status = getConfigStatus(nextConfig)
    note =
      'Switched Opus, Sonnet, and Haiku to the selected model because Claude Code currently supports only one active provider at a time.'
  }

  if (!status.opusModelId || !status.sonnetModelId || !status.haikuModelId) {
    throw new Error('Unable to resolve Opus, Sonnet, and Haiku models after update')
  }

  return {
    nextConfig,
    opusModelId: status.opusModelId,
    sonnetModelId: status.sonnetModelId,
    haikuModelId: status.haikuModelId,
    note,
  }
}

function writeClaudeConfigFile(
  configPath: string,
  config: EditableClaudeConfigFile,
): void {
  writeFileSyncAndFlush_DEPRECATED(
    configPath,
    `${jsonStringify(config, null, 2)}\n`,
    { encoding: 'utf8' },
  )
}

function ApplyModelsAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const setAppState = useSetAppState()

  React.useEffect(() => {
    const command = parseCommand(args)

    if (command.type === 'help') {
      onDone(getHelpText(), { display: 'system' })
      return
    }

    const configPath = findClaudeConfigFilePath()
    if (!configPath) {
      onDone(`Could not find ${CLAUDE_CONFIG_FILE_NAME} near the Claude Code entrypoint.`, {
        display: 'system',
      })
      return
    }

    try {
      const config = readClaudeConfigFile(configPath)

      if (command.type === 'show') {
        onDone(buildStatusMessage(config), { display: 'system' })
        return
      }

      const { nextConfig, opusModelId, sonnetModelId, haikuModelId, note } =
        updateConfiguredModels(config, command.target, command.modelId)

      writeClaudeConfigFile(configPath, nextConfig)
      resetClaudeConfigEnvironmentVariablesCache()
      reset3PModelCapabilityOverrideCache()
      applyConfigEnvironmentVariables()
      const mainLoopModelId = getDefaultMainLoopModel()
      setMainLoopModelOverride(mainLoopModelId)
      setInitialMainLoopModel(mainLoopModelId)
      setAppState(prev => ({
        ...prev,
        mainLoopModel: mainLoopModelId,
        mainLoopModelForSession: null,
      }))

      const lines = [
        `Opus model: ${chalk.bold(opusModelId)}`,
        `Sonnet model: ${chalk.bold(sonnetModelId)}`,
        `Haiku model: ${chalk.bold(haikuModelId)}`,
        `Main loop model: ${chalk.bold(mainLoopModelId)}`,
      ]
      if (note) {
        lines.push(note)
      }
      onDone(lines.join('\n'), { display: 'system' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onDone(`Failed to update models: ${message}`, { display: 'system' })
    }
  }, [args, onDone, setAppState])

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  return <ApplyModelsAndClose args={args?.trim() || ''} onDone={onDone} />
}