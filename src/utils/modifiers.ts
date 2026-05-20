export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false
let warnedMissingNativeModule = false

type NativeModifiersModule = {
  isModifierPressed: (modifier: string) => boolean
  prewarm?: () => void
}

function getNativeModifiersModule(): NativeModifiersModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('modifiers-napi') as NativeModifiersModule
  } catch (error) {
    if (!warnedMissingNativeModule) {
      warnedMissingNativeModule = true
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[WARN] modifiers-napi unavailable, falling back to standard key handling: ${message}\n`,
      )
    }
    return null
  }
}

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  // Load module in background
  getNativeModifiersModule()?.prewarm?.()
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const nativeModule = getNativeModifiersModule()
  return nativeModule ? nativeModule.isModifierPressed(modifier) : false
}

