import { isEnvTruthy } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { jsonStringify } from './slowOperations.js'

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|auth(?:orization)?|bearer|client[_-]?secret|password|secret|token)/i

export function isFullSessionDebugEnabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_FULL_SESSION_DEBUG) ||
    isEnvTruthy(process.env.CLAUDE_CODE_SESSION_DEBUG_LOG)
  )
}

function normalizeForDebugLog(
  value: unknown,
  seen: WeakSet<object>,
  key?: string,
): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) {
    return '[REDACTED]'
  }
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'function') {
    return `[Function ${(value as Function).name || 'anonymous'}]`
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  if (typeof value !== 'object') {
    return String(value)
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map(item => normalizeForDebugLog(item, seen))
  }
  const normalized: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    normalized[entryKey] = normalizeForDebugLog(entryValue, seen, entryKey)
  }
  return normalized
}

export function logSessionDebugEvent(
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!isFullSessionDebugEnabled()) {
    return
  }

  const payload = {
    event,
    ...(data ? { data: normalizeForDebugLog(data, new WeakSet()) } : {}),
  }
  logForDebugging(`session-debug ${jsonStringify(payload)}`)
}
