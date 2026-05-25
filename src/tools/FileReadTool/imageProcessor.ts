import type { Buffer } from 'buffer'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null
let imageProcessorLoadError: ImageProcessorUnavailableError | null = null
let imageCreatorLoadError: ImageProcessorUnavailableError | null = null

export class ImageProcessorUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageProcessorUnavailableError'
  }
}

export function isImageProcessorUnavailableError(
  error: unknown,
): error is ImageProcessorUnavailableError {
  return error instanceof ImageProcessorUnavailableError
}

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (imageProcessorLoadError) {
    throw imageProcessorLoadError
  }

  if (isInBundledMode()) {
    // Try to load the native image processor first
    try {
      // Use the native image processor module
      const imageProcessor = await import('image-processor-napi')
      const sharp = imageProcessor.sharp || imageProcessor.default
      imageProcessorModule = { default: sharp }
      return sharp
    } catch {
      // Fall back to sharp if native module is not available
      // biome-ignore lint/suspicious/noConsole: intentional warning
      console.warn(
        'Native image processor not available, falling back to sharp',
      )
    }
  }

  // Use sharp for non-bundled builds or as fallback.
  // Single structural cast: our SharpFunction is a subset of sharp's actual type surface.
  try {
    const imported = (await import(
      'sharp'
    )) as unknown as MaybeDefault<SharpFunction>
    const sharp = unwrapDefault(imported)
    imageProcessorModule = { default: sharp }
    return sharp
  } catch (error) {
    const unavailableError = toImageProcessorUnavailableError(error)
    imageProcessorLoadError = unavailableError
    throw unavailableError
  }
}

/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  if (imageCreatorLoadError) {
    throw imageCreatorLoadError
  }

  try {
    const imported = (await import(
      'sharp'
    )) as unknown as MaybeDefault<SharpCreator>
    const sharp = unwrapDefault(imported)
    imageCreatorModule = { default: sharp }
    return sharp
  } catch (error) {
    const unavailableError = toImageProcessorUnavailableError(error)
    imageCreatorLoadError = unavailableError
    throw unavailableError
  }
}

// Dynamic import shape varies by module interop mode — ESM yields { default: fn }, CJS yields fn directly.
type MaybeDefault<T> = T | { default: T }

function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}

function toImageProcessorUnavailableError(
  error: unknown,
): ImageProcessorUnavailableError {
  if (isImageProcessorUnavailableError(error)) {
    return error
  }

  if (!isMissingImageProcessorDependency(error)) {
    throw error
  }

  return new ImageProcessorUnavailableError(
    'Image processing is unavailable because the runtime dependency "sharp" is missing or failed to load. Install "sharp" to enable image resizing and format conversion.',
  )
}

function isMissingImageProcessorDependency(error: unknown): boolean {
  const code = getErrnoCode(error)
  if (
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'ERR_DLOPEN_FAILED'
  ) {
    return true
  }

  const message = errorMessage(error)
  return (
    message.includes("Cannot find package 'sharp'") ||
    message.includes('Could not load the "sharp" module') ||
    message.includes('ERR_DLOPEN_FAILED')
  )
}

