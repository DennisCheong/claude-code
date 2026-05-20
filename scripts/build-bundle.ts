// scripts/build-bundle.ts
// Usage: bun scripts/build-bundle.ts [--watch] [--minify] [--no-sourcemap]
//
// Production build: bun scripts/build-bundle.ts --minify
// Dev build:        bun scripts/build-bundle.ts
// Watch mode:       bun scripts/build-bundle.ts --watch

import * as esbuild from 'esbuild'
import { resolve, dirname } from 'path'
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'

// Bun: import.meta.dir — Node 21+: import.meta.dirname — fallback
const __dir: string =
  (import.meta as any).dir ??
  (import.meta as any).dirname ??
  dirname(fileURLToPath(import.meta.url))

const ROOT = resolve(__dir, '..')
const CLAUDE_CONFIG_FILE_NAME = 'claude-config.json'
const watch = process.argv.includes('--watch')
const minify = process.argv.includes('--minify')
const noSourcemap = process.argv.includes('--no-sourcemap')

function syncClaudeConfigToDist(): void {
  const sourcePath = resolve(ROOT, CLAUDE_CONFIG_FILE_NAME)
  const distPath = resolve(ROOT, 'dist', CLAUDE_CONFIG_FILE_NAME)

  if (existsSync(sourcePath)) {
    copyFileSync(sourcePath, distPath)
    return
  }

  if (existsSync(distPath)) {
    rmSync(distPath)
  }
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key]
  if (value === undefined) {
    return fallback
  }

  return value === '1' || value === 'true'
}

function getFeatureDefault(flagName: string): boolean {
  switch (flagName) {
    case 'SSH_REMOTE':
      return true
    default:
      return false
  }
}

function getLoader(filePath: string): esbuild.Loader | null {
  if (filePath.endsWith('.tsx')) return 'tsx'
  if (filePath.endsWith('.ts')) return 'ts'
  if (filePath.endsWith('.jsx')) return 'jsx'
  if (filePath.endsWith('.js')) return 'js'
  return null
}

function resolveSourcePath(basePath: string): string | undefined {
  if (existsSync(basePath)) {
    return basePath
  }

  const withoutExt = basePath.replace(/\.(js|jsx)$/, '')
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = withoutExt + ext
    if (existsSync(candidate)) {
      return candidate
    }
  }

  const dirPath = withoutExt
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = resolve(dirPath, 'index' + ext)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

function resolveImportBasePath(args: esbuild.OnResolveArgs): string {
  return args.path.startsWith('src/')
    ? resolve(ROOT, args.path)
    : resolve(args.resolveDir, args.path)
}

const featureFlagInliningPlugin: esbuild.Plugin = {
  name: 'feature-flag-inline',
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx?$/ }, args => {
      if (args.path.includes('/node_modules/')) {
        return undefined
      }

      if (!existsSync(args.path)) {
        return undefined
      }

      const loader = getLoader(args.path)
      if (!loader) {
        return undefined
      }

      const contents = readFileSync(args.path, 'utf-8').replace(
        /feature\(\s*['\"]([A-Z0-9_]+)['\"]\s*\)/g,
        (_match, flagName: string) =>
          String(envBool(`CLAUDE_CODE_${flagName}`, getFeatureDefault(flagName))),
      )

      return { contents, loader }
    })
  },
}

// Read version from package.json for MACRO injection
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const version = pkg.version || '0.0.0-dev'

// ── Plugin: resolve source imports and build-only fallbacks ──
const srcResolverPlugin: esbuild.Plugin = {
  name: 'src-resolver',
  setup(build) {
    const tryResolve = (basePath: string) => {
      const resolved = resolveSourcePath(basePath)
      return resolved ? { path: resolved } : undefined
    }
    const hasClaudeForChromeMcpPackage = existsSync(
      resolve(
        ROOT,
        'node_modules',
        '@ant',
        'claude-for-chrome-mcp',
        'package.json',
      ),
    )

    const registerMissingSourceStub = (
      filter: RegExp,
      namespace: string,
    ) => {
      build.onResolve({ filter }, args => {
        const resolved = tryResolve(resolveImportBasePath(args))
        if (resolved) {
          return resolved
        }

        return {
          path: resolveImportBasePath(args),
          namespace,
        }
      })
    }

    build.onResolve({ filter: /^src\// }, (args) => {
      return tryResolve(resolve(ROOT, args.path))
    })

    build.onResolve({ filter: /^\.{1,2}\/.+\.(js|jsx)$/ }, args => {
      return tryResolve(resolve(args.resolveDir, args.path))
    })

    build.onResolve({ filter: /^@ant\/claude-for-chrome-mcp$/ }, () => {
      if (hasClaudeForChromeMcpPackage) {
        return undefined
      }

      return {
        path: '@ant/claude-for-chrome-mcp',
        namespace: 'claude-for-chrome-mcp-stub',
      }
    })

    registerMissingSourceStub(/global\.d\.ts$/, 'empty-js-module')
    registerMissingSourceStub(/sdk\/runtimeTypes\.js$/, 'empty-js-module')
    registerMissingSourceStub(/sdk\/toolTypes\.js$/, 'empty-js-module')
    registerMissingSourceStub(/coreTypes\.generated\.js$/, 'empty-js-module')
    registerMissingSourceStub(
      /VerifyPlanExecutionTool\/VerifyPlanExecutionTool\.js$/,
      'verify-plan-stub',
    )
    registerMissingSourceStub(/snipCompact\.js$/, 'snip-compact-stub')
    registerMissingSourceStub(
      /cachedMicrocompact\.js$/,
      'cached-microcompact-stub',
    )
    registerMissingSourceStub(
      /WorkflowTool\/constants\.js$/,
      'workflow-constants-stub',
    )
    registerMissingSourceStub(
      /DiscoverSkillsTool\/prompt\.js$/,
      'discover-skills-stub',
    )
    registerMissingSourceStub(
      /SnapshotUpdateDialog\.js$/,
      'snapshot-update-dialog-stub',
    )
    registerMissingSourceStub(
      /AssistantSessionChooser\.js$/,
      'assistant-session-chooser-stub',
    )
    registerMissingSourceStub(
      /commands\/assistant\/assistant\.js$/,
      'assistant-install-stub',
    )

    build.onResolve({ filter: /(^\.\/types\.js$|filePersistence\/types\.js$)/ }, args => {
      if (!args.resolveDir.endsWith('/src/utils/filePersistence')) {
        return undefined
      }

      const resolved = tryResolve(resolveImportBasePath(args))
      if (resolved) {
        return resolved
      }

      return {
        path: resolveImportBasePath(args),
        namespace: 'file-persistence-types-stub',
      }
    })

    build.onResolve({ filter: /contextCollapse\/index\.js$/ }, args => {
      const resolved = tryResolve(resolveImportBasePath(args))
      if (resolved) {
        return resolved
      }

      return {
        path: resolveImportBasePath(args),
        namespace: 'context-collapse-stub',
      }
    })

    build.onResolve({ filter: /connectorText\.js$/ }, args => {
      const resolved = tryResolve(resolveImportBasePath(args))
      if (resolved) {
        return resolved
      }

      return {
        path: resolveImportBasePath(args),
        namespace: 'connector-text-stub',
      }
    })

    build.onResolve({ filter: /TungstenTool\/TungstenTool\.js$/ }, args => {
      const resolved = tryResolve(resolveImportBasePath(args))
      if (resolved) {
        return resolved
      }

      return {
        path: resolveImportBasePath(args),
        namespace: 'tungsten-tool-stub',
      }
    })

    build.onResolve({ filter: /TungstenTool\/TungstenLiveMonitor\.js$/ }, args => {
      const resolved = tryResolve(resolveImportBasePath(args))
      if (resolved) {
        return resolved
      }

      return {
        path: resolveImportBasePath(args),
        namespace: 'tungsten-monitor-stub',
      }
    })

    build.onResolve({ filter: /devtools\.js$/ }, args => {
      const resolved = tryResolve(resolveImportBasePath(args))
      if (resolved) {
        return resolved
      }

      return {
        path: resolveImportBasePath(args),
        namespace: 'empty-js-module',
      }
    })

    build.onResolve({ filter: /\.(md|txt)$/ }, args => {
      if (!args.path.startsWith('.')) {
        return undefined
      }

      const candidate = resolveImportBasePath(args)
      if (existsSync(candidate)) {
        return { path: candidate }
      }

      return {
        path: candidate,
        namespace: 'empty-text-module',
      }
    })

    build.onLoad({ filter: /.*/, namespace: 'empty-js-module' }, () => ({
      contents: 'export {}',
      loader: 'js',
    }))

    build.onLoad({ filter: /.*/, namespace: 'verify-plan-stub' }, () => ({
      contents: "export const VerifyPlanExecutionTool = null",
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'workflow-constants-stub' }, () => ({
      contents: "export const WORKFLOW_TOOL_NAME = 'workflow'",
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'discover-skills-stub' }, () => ({
      contents: [
        "export const DISCOVER_SKILLS_TOOL_NAME = 'discover_skills'",
      ].join('\n'),
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'snapshot-update-dialog-stub' }, () => ({
      contents: [
        'export function SnapshotUpdateDialog() {',
        '  return null',
        '}',
      ].join('\n'),
      loader: 'tsx',
    }))

    build.onLoad({ filter: /.*/, namespace: 'assistant-session-chooser-stub' }, () => ({
      contents: [
        'export function AssistantSessionChooser() {',
        '  return null',
        '}',
      ].join('\n'),
      loader: 'tsx',
    }))

    build.onLoad({ filter: /.*/, namespace: 'assistant-install-stub' }, () => ({
      contents: [
        'export async function computeDefaultInstallDir() {',
        "  return ''",
        '}',
        'export function NewInstallWizard() {',
        '  return null',
        '}',
      ].join('\n'),
      loader: 'tsx',
    }))

    build.onLoad({ filter: /.*/, namespace: 'snip-compact-stub' }, () => ({
      contents: [
        'export function isSnipRuntimeEnabled() {',
        '  return false',
        '}',
        'export function shouldNudgeForSnips() {',
        '  return false',
        '}',
        'export function isSnipBoundaryMessage() {',
        '  return false',
        '}',
        'export function hasSnipReferenceBlocks() {',
        '  return false',
        '}',
        'export function makeSnipToolReferenceBlock() {',
        '  return null',
        '}',
        'export function shouldReplaceLargeToolBlocksWithReferences() {',
        '  return false',
        '}',
        'export function createSnipToolResult() {',
        '  return null',
        '}',
        'export function snipCompactIfNeeded(messages) {',
        '  return { messages, tokensFreed: 0, boundaryMessage: undefined }',
        '}',
      ].join('\n'),
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'cached-microcompact-stub' }, () => ({
      contents: [
        'export function isCachedMicrocompactEnabled() {',
        '  return false',
        '}',
        'export function isModelSupportedForCacheEditing() {',
        '  return false',
        '}',
        'export function getCachedMCConfig() {',
        '  return { supportedModels: [], triggerCount: 0, keepCount: 0 }',
        '}',
        'export function createCachedMCState() {',
        '  return { registeredTools: new Set(), pinnedEdits: [] }',
        '}',
        'export function registerToolResult(state, toolId) {',
        '  state.registeredTools.add(toolId)',
        '}',
        'export function registerToolMessage() {}',
        'export function getToolResultsToDelete() {',
        '  return []',
        '}',
        'export function createCacheEditsBlock() {',
        '  return null',
        '}',
      ].join('\n'),
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'empty-text-module' }, () => ({
      contents: '',
      loader: 'text',
    }))

    build.onLoad({ filter: /.*/, namespace: 'connector-text-stub' }, () => ({
      contents: [
        'export function isConnectorTextBlock() {',
        '  return false',
        '}',
      ].join('\n'),
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'tungsten-tool-stub' }, () => ({
      contents: [
        "export const TungstenTool = Symbol('TungstenTool')",
        'export function clearSessionsWithTungstenUsage() {}',
        'export function resetInitializationState() {}',
      ].join('\n'),
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'tungsten-monitor-stub' }, () => ({
      contents: [
        'export function TungstenLiveMonitor() {',
        '  return null',
        '}',
      ].join('\n'),
      loader: 'ts',
    }))

    build.onLoad({ filter: /.*/, namespace: 'context-collapse-stub' }, () => ({
      contents: [
        'const STATS = {',
        '  collapsedSpans: 0,',
        '  collapsedMessages: 0,',
        '  stagedSpans: 0,',
        '  health: {',
        '    totalErrors: 0,',
        '    totalSpawns: 0,',
        '    totalEmptySpawns: 0,',
        '    emptySpawnWarningEmitted: false,',
        '    lastError: null,',
        '  },',
        '}',
        'export function getStats() {',
        '  return STATS',
        '}',
        'export function subscribe() {',
        '  return () => {}',
        '}',
        'export function isContextCollapseEnabled() {',
        '  return false',
        '}',
        'export function resetContextCollapse() {}',
        'export async function applyCollapsesIfNeeded(input) {',
        '  return { messages: input?.messages ?? [], summaryMessages: [] }',
        '}',
        'export function isWithheldPromptTooLong() {',
        '  return false',
        '}',
        'export function recoverFromOverflow() {',
        '  return null',
        '}',
      ].join('\n'),
      loader: 'ts',
    }))

    build.onLoad(
      { filter: /.*/, namespace: 'file-persistence-types-stub' },
      () => ({
        contents: [
          "export const DEFAULT_UPLOAD_CONCURRENCY = 4",
          "export const FILE_COUNT_LIMIT = 1000",
          "export const OUTPUTS_SUBDIR = 'outputs'",
        ].join('\n'),
        loader: 'ts',
      }),
    )

    build.onLoad(
      {
        filter: /^@ant\/claude-for-chrome-mcp$/,
        namespace: 'claude-for-chrome-mcp-stub',
      },
      () => ({
        contents: [
          'export const BROWSER_TOOLS = []',
          'export function createClaudeForChromeMcpServer() {',
          "  throw new Error('@ant/claude-for-chrome-mcp is not installed in this build. Claude in Chrome is unavailable.')",
          '}',
        ].join('\n'),
        loader: 'ts',
      }),
    )
  },
}

const buildOptions: esbuild.BuildOptions = {
  entryPoints: [resolve(ROOT, 'src/entrypoints/cli.tsx')],
  bundle: true,
  platform: 'node',
  target: ['node20', 'es2022'],
  format: 'esm',
  outdir: resolve(ROOT, 'dist'),
  outExtension: { '.js': '.mjs' },

  // Single-file output — no code splitting for CLI tools
  splitting: false,

  plugins: [featureFlagInliningPlugin, srcResolverPlugin],

  // Use tsconfig for baseUrl / paths resolution (complements plugin above)
  tsconfig: resolve(ROOT, 'tsconfig.json'),

  // Alias bun:bundle to our runtime shim
  alias: {
    'bun:bundle': resolve(ROOT, 'src/shims/bun-bundle.ts'),
  },

  // Don't bundle node built-ins or problematic native packages
  external: [
    // Node built-ins (with and without node: prefix)
    'fs', 'path', 'os', 'crypto', 'child_process', 'http', 'https',
    'net', 'tls', 'url', 'util', 'stream', 'events', 'buffer',
    'querystring', 'readline', 'zlib', 'assert', 'tty', 'worker_threads',
    'perf_hooks', 'async_hooks', 'dns', 'dgram', 'cluster',
    'string_decoder', 'module', 'vm', 'constants', 'domain',
    'console', 'process', 'v8', 'inspector',
    'node:*',
    // Native addons that can't be bundled
    'fsevents',
    'sharp',
    'image-processor-napi',
    // Anthropic-internal packages (not published externally)
    '@anthropic-ai/sandbox-runtime',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/bedrock-sdk',
    '@anthropic-ai/foundry-sdk',
    '@anthropic-ai/mcpb',
    '@anthropic-ai/vertex-sdk',
    // Anthropic-internal (@ant/) packages — gated behind USER_TYPE === 'ant'
    '@ant/*',
    '@aws-sdk/client-bedrock',
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-sts',
    '@aws-sdk/credential-provider-node',
    '@alcalzone/ansi-tokenize',
    '@azure/identity',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/exporter-logs-otlp-proto',
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-proto',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-trace-otlp-proto',
    'asciichart',
    'bidi-js',
    'color-diff-napi',
    'google-auth-library',
    'lru-cache',
    'modifiers-napi',
    '@smithy/core',
    '@smithy/node-http-handler',
  ],

  jsx: 'automatic',

  // Source maps for production debugging (external .map files)
  sourcemap: noSourcemap ? false : 'external',

  // Minification for production
  minify,

  // Tree shaking (on by default, explicit for clarity)
  treeShaking: true,

  // Define replacements — inline constants at build time
  // MACRO.* — originally inlined by Bun's bundler at compile time
  // process.env.USER_TYPE — eliminates 'ant' (Anthropic-internal) code branches
  define: {
    'MACRO.VERSION': JSON.stringify(version),
    'MACRO.PACKAGE_URL': JSON.stringify('@anthropic-ai/claude-code'),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      'report issues at https://github.com/anthropics/claude-code/issues'
    ),
    'process.env.USER_TYPE': '"external"',
    'process.env.NODE_ENV': minify ? '"production"' : '"development"',
  },

  // Banner: shebang for direct CLI execution
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __createRequire } from "node:module";',
      'const require = __createRequire(import.meta.url);',
      '',
    ].join('\n'),
  },

  // Handle the .js → .ts resolution that the codebase uses
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],

  loader: {
    '.md': 'text',
    '.txt': 'text',
  },

  logLevel: 'info',

  // Metafile for bundle analysis
  metafile: true,
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log('Watching for changes...')
  } else {
    const startTime = Date.now()
    const result = await esbuild.build(buildOptions)

    if (result.errors.length > 0) {
      console.error('Build failed')
      process.exit(1)
    }

    // Make the output executable
    const outPath = resolve(ROOT, 'dist/cli.mjs')
    try {
      chmodSync(outPath, 0o755)
    } catch {
      // chmod may fail on some platforms, non-fatal
    }

    syncClaudeConfigToDist()

    const elapsed = Date.now() - startTime

    // Print bundle size info
    if (result.metafile) {
      const text = await esbuild.analyzeMetafile(result.metafile, { verbose: false })
      const outFiles = Object.entries(result.metafile.outputs)
      for (const [file, info] of outFiles) {
        if (file.endsWith('.mjs')) {
          const sizeMB = ((info as { bytes: number }).bytes / 1024 / 1024).toFixed(2)
          console.log(`\n  ${file}: ${sizeMB} MB`)
        }
      }
      console.log(`\nBuild complete in ${elapsed}ms → dist/`)

      // Write metafile for further analysis
      const { writeFileSync } = await import('fs')
      writeFileSync(
        resolve(ROOT, 'dist/meta.json'),
        JSON.stringify(result.metafile),
      )
      console.log('  Metafile written to dist/meta.json')
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
