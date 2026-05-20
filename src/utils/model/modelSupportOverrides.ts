import memoize from 'lodash-es/memoize.js'
import {
  getClaudeConfigModelCapabilityOverride,
  type ClaudeConfigModelCapability,
} from '../claudeConfigEnv.js'
import { getAPIProvider } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'
  | 'structured_outputs'
  | 'web_search'

const CONFIG_CAPABILITY_MAP: Record<
  ModelCapabilityOverride,
  ClaudeConfigModelCapability
> = {
  effort: 'effort',
  max_effort: 'maxEffort',
  thinking: 'thinking',
  adaptive_thinking: 'adaptiveThinking',
  interleaved_thinking: 'interleavedThinking',
  structured_outputs: 'structuredOutputs',
  web_search: 'webSearch',
}

const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars.
 */
const get3PModelCapabilityOverrideMemoized = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    if (getAPIProvider() === 'firstParty') {
      return undefined
    }

    const configuredOverride = getClaudeConfigModelCapabilityOverride(
      model,
      CONFIG_CAPABILITY_MAP[capability],
    )
    if (configuredOverride !== undefined) {
      return configuredOverride
    }

    const m = model.toLowerCase()
    for (const tier of TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== pinned.toLowerCase()) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => `${model.toLowerCase()}:${capability}`,
)

export function get3PModelCapabilityOverride(
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined {
  return get3PModelCapabilityOverrideMemoized(model, capability)
}

export function reset3PModelCapabilityOverrideCache(): void {
  get3PModelCapabilityOverrideMemoized.cache.clear?.()
}

