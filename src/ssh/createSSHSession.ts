import { spawn } from 'child_process'
import { posix as posixPath, resolve as resolveLocalPath } from 'path'

type ProgressHandlers = {
  onProgress?: (message: string) => void
}

type CommonSessionOptions = {
  cwd?: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
  localVersion?: string
}

type CreateSSHSessionOptions = CommonSessionOptions & {
  host: string
}

type RunShellResult = {
  stdout: string
  stderr: string
  exitCode: number
}

const SSH_CONTROL_PATH = '~/.ssh/claude-code-%C'
const SSH_CONTROL_MASTER_ARGS = [
  '-o',
  'ControlMaster=yes',
  '-o',
  'ControlPersist=10m',
  '-o',
  `ControlPath=${SSH_CONTROL_PATH}`,
] as const
const SSH_CONTROL_CLIENT_ARGS = [
  '-o',
  'ControlMaster=no',
  '-o',
  'BatchMode=yes',
  '-o',
  `ControlPath=${SSH_CONTROL_PATH}`,
] as const
const MAX_CONCURRENT_REMOTE_SHELL_COMMANDS = 4

export type RemotePathKind = 'file' | 'directory' | 'other'

export type RemotePathStat = {
  exists: boolean
  kind?: RemotePathKind
  size?: number
  mtimeMs?: number
}

export type RemoteDirectoryListing = {
  entries: string[]
  totalEntries: number
  truncated: boolean
}

export type RemoteTextFileResult = {
  content: string
  startLine: number
  numLines: number
  totalLines: number
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseOptionalInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function countTextLines(content: string): number {
  if (content.length === 0) {
    return 0
  }

  const newlineCount = content.split('\n').length - 1
  return newlineCount + (content.endsWith('\n') ? 0 : 1)
}

function buildRemoteShellCommand(command: string): string {
  return `sh -lc ${quoteForPosixShell(command)}`
}

function normalizeRemoteCwdInput(cwd: string | undefined): string | undefined {
  if (!cwd) {
    return undefined
  }

  // Shells expand an unquoted `~/path` before this CLI sees argv. In SSH mode
  // the cwd positional is intended for the remote machine, so map the local
  // home prefix back to a remote-home token before sending it over SSH.
  const localHome = process.env.HOME
  if (localHome && (cwd === localHome || cwd.startsWith(`${localHome}/`))) {
    return `~${cwd.slice(localHome.length)}`
  }

  return cwd
}

function buildRemoteCdCommand(cwd: string): string {
  if (cwd === '~') {
    return 'cd "$HOME"'
  }

  if (cwd.startsWith('~/')) {
    return `cd "$HOME"/${quoteForPosixShell(cwd.slice(2))}`
  }

  return `cd ${quoteForPosixShell(cwd)}`
}

function runProcess(
  command: string,
  args: string[],
  options?: { stdin?: string; stdio?: 'pipe' | 'inherit' },
): Promise<RunShellResult> {
  return new Promise((resolve, reject) => {
    const stdio = options?.stdio === 'inherit' ? 'inherit' : 'pipe'
    const child = spawn(command, args, {
      stdio,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString()
    })

    child.stderr?.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', code => {
      if ((code ?? 1) !== 0) {
        reject(
          new SSHSessionError(
            stderr.trim() || `Command failed with exit code ${code ?? 'unknown'}`,
          ),
        )
        return
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      })
    })

    if (options?.stdin !== undefined && child.stdin) {
      child.stdin.write(options.stdin)
    }
    child.stdin?.end()
  })
}

async function ensureSshControlMaster(host: string): Promise<void> {
  await runProcess('ssh', [...SSH_CONTROL_MASTER_ARGS, '-fN', host], {
    stdio: 'inherit',
  })
}

async function closeSshControlMaster(host: string): Promise<void> {
  try {
    await runProcess('ssh', [...SSH_CONTROL_CLIENT_ARGS, '-O', 'exit', host])
  } catch {
    // Ignore cleanup failures for already-closed masters.
  }
}

export class SSHSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHSessionError'
  }
}

export class RemoteWorkspaceSession {
  private activeRemoteShellCommands = 0
  private readonly remoteShellWaiters: Array<() => void> = []

  constructor(
    readonly remoteHost: string,
    readonly remoteRoot: string,
    readonly isLocalTransport: boolean,
    private readonly sshArgs: string[] = [],
  ) {}

  private async runWithRemoteShellSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isLocalTransport) {
      return operation()
    }

    if (this.activeRemoteShellCommands >= MAX_CONCURRENT_REMOTE_SHELL_COMMANDS) {
      await new Promise<void>(resolve => {
        this.remoteShellWaiters.push(resolve)
      })
    }

    this.activeRemoteShellCommands += 1
    try {
      return await operation()
    } finally {
      this.activeRemoteShellCommands -= 1
      this.remoteShellWaiters.shift()?.()
    }
  }

  resolveRemotePath(targetPath: string): string {
    if (!targetPath.trim()) {
      return this.remoteRoot
    }

    return targetPath.startsWith('/')
      ? posixPath.normalize(targetPath)
      : posixPath.resolve(this.remoteRoot, targetPath)
  }

  toPathToken(targetPath: string): string {
    const resolvedPath = this.resolveRemotePath(targetPath)
    if (resolvedPath === this.remoteRoot) {
      return '$.'
    }

    const relativePath = posixPath.relative(this.remoteRoot, resolvedPath)
    if (relativePath && !relativePath.startsWith('..')) {
      return `$${relativePath}`
    }

    return `$${resolvedPath}`
  }

  async runShell(
    command: string,
    options?: { cwd?: string; stdin?: string },
  ): Promise<RunShellResult> {
    const workingDirectory = options?.cwd
      ? this.resolveRemotePath(options.cwd)
      : this.remoteRoot
    const wrappedCommand = `cd ${quoteForPosixShell(workingDirectory)} && ${command}`

    if (this.isLocalTransport) {
      return runProcess('sh', ['-lc', wrappedCommand], {
        stdin: options?.stdin,
      })
    }

    return this.runWithRemoteShellSlot(() =>
      runProcess('ssh', [
        ...this.sshArgs,
        this.remoteHost,
        buildRemoteShellCommand(wrappedCommand),
      ], {
        stdin: options?.stdin,
      }),
    )
  }

  async statPath(targetPath: string): Promise<RemotePathStat> {
    const resolvedPath = this.resolveRemotePath(targetPath)
    const quotedPath = quoteForPosixShell(resolvedPath)
    const { stdout } = await this.runShell(
      [
        `if [ -d ${quotedPath} ]; then`,
        `  size=0`,
        `  mtime=$(stat -c %Y ${quotedPath} 2>/dev/null || stat -f %m ${quotedPath} 2>/dev/null || printf '')`,
        `  printf 'directory\t%s\t%s' "$size" "$mtime"`,
        `elif [ -f ${quotedPath} ]; then`,
        `  size=$(wc -c < ${quotedPath} | tr -d '[:space:]')`,
        `  mtime=$(stat -c %Y ${quotedPath} 2>/dev/null || stat -f %m ${quotedPath} 2>/dev/null || printf '')`,
        `  printf 'file\t%s\t%s' "$size" "$mtime"`,
        `elif [ -e ${quotedPath} ]; then`,
        `  mtime=$(stat -c %Y ${quotedPath} 2>/dev/null || stat -f %m ${quotedPath} 2>/dev/null || printf '')`,
        `  printf 'other\t0\t%s' "$mtime"`,
        `else`,
        `  printf 'missing'`,
        `fi`,
      ].join('\n'),
    )

    const trimmed = stdout.trim()
    if (trimmed === 'missing' || trimmed.length === 0) {
      return { exists: false }
    }

    const [kind, sizeValue, mtimeValue] = trimmed.split('\t')
    const size = parseOptionalInteger(sizeValue)
    const mtimeSeconds = parseOptionalInteger(mtimeValue)

    return {
      exists: true,
      kind: kind as RemotePathKind,
      size,
      ...(mtimeSeconds !== undefined ? { mtimeMs: mtimeSeconds * 1000 } : {}),
    }
  }

  async listDirectory(
    targetPath: string,
    maxEntries: number,
  ): Promise<RemoteDirectoryListing> {
    const resolvedPath = this.resolveRemotePath(targetPath)
    const quotedPath = quoteForPosixShell(resolvedPath)
    const { stdout } = await this.runShell(`LC_ALL=C ls -1A ${quotedPath}`)
    const entries = stdout
      .split('\n')
      .map(entry => entry.trim())
      .filter(Boolean)

    return {
      entries: entries.slice(0, maxEntries),
      totalEntries: entries.length,
      truncated: entries.length > maxEntries,
    }
  }

  async readTextFile(
    targetPath: string,
    options?: { offset?: number; limit?: number },
  ): Promise<RemoteTextFileResult> {
    const resolvedPath = this.resolveRemotePath(targetPath)
    const quotedPath = quoteForPosixShell(resolvedPath)
    const startLine = options?.offset ?? 1
    const endLine =
      options?.limit !== undefined
        ? startLine + options.limit - 1
        : undefined

    const [{ stdout: totalLinesRaw }, { stdout: content }] = await Promise.all([
      this.runShell(`awk 'END { print NR }' ${quotedPath}`),
      this.runShell(
        endLine !== undefined
          ? `sed -n '${startLine},${endLine}p' ${quotedPath}`
          : `cat ${quotedPath}`,
      ),
    ])

    const totalLines = parseOptionalInteger(totalLinesRaw) ?? 0

    return {
      content,
      startLine,
      numLines: countTextLines(content),
      totalLines,
    }
  }

  async readFileBytes(
    targetPath: string,
    options?: { maxBytes?: number },
  ): Promise<Buffer> {
    const resolvedPath = this.resolveRemotePath(targetPath)
    const quotedPath = quoteForPosixShell(resolvedPath)
    const command =
      options?.maxBytes !== undefined
        ? `head -c ${Math.max(0, options.maxBytes)} ${quotedPath} | base64 | tr -d '\\n'`
        : `base64 < ${quotedPath} | tr -d '\\n'`
    const { stdout } = await this.runShell(command)
    return Buffer.from(stdout.trim(), 'base64')
  }

  async writeTextFile(targetPath: string, content: string): Promise<void> {
    const resolvedPath = this.resolveRemotePath(targetPath)
    const quotedPath = quoteForPosixShell(resolvedPath)
    const quotedDir = quoteForPosixShell(posixPath.dirname(resolvedPath))

    await this.runShell(`mkdir -p ${quotedDir} && cat > ${quotedPath}`, {
      stdin: content,
    })
  }

  async findFiles(
    targetPath: string,
    options?: { namePattern?: string },
  ): Promise<string[]> {
    const resolvedPath = this.resolveRemotePath(targetPath)
    const quotedPath = quoteForPosixShell(resolvedPath)
    const namePattern = options?.namePattern
      ? ` -name ${quoteForPosixShell(options.namePattern)}`
      : ''
    const { stdout } = await this.runShell(
      `if [ -d ${quotedPath} ]; then find ${quotedPath} -type f${namePattern} | LC_ALL=C sort; elif [ -f ${quotedPath} ]; then printf '%s\n' ${quotedPath}; fi`,
    )

    return stdout
      .split('\n')
      .map(path => path.trim())
      .filter(Boolean)
  }

  async findMarkdownFiles(targetPath: string): Promise<string[]> {
    return this.findFiles(targetPath, { namePattern: '*.md' })
  }

  close(): void {}
}

export type SSHSession = {
  remoteCwd: string
  workspace: RemoteWorkspaceSession
  close(): void
}

async function resolveRemoteCwd(
  run: (command: string) => Promise<RunShellResult>,
  cwd?: string,
): Promise<string> {
  const normalizedCwd = normalizeRemoteCwdInput(cwd)
  const command = normalizedCwd
    ? `${buildRemoteCdCommand(normalizedCwd)} && pwd -P`
    : 'pwd -P'
  const { stdout } = await run(command)
  const resolved = stdout.trim()

  if (!resolved) {
    throw new SSHSessionError('Failed to resolve the remote working directory.')
  }

  return resolved
}

export async function createSSHSession(
  options: CreateSSHSessionOptions,
  progress?: ProgressHandlers,
): Promise<SSHSession> {
  // Do not emit an in-place progress line before the interactive OpenSSH
  // password prompt. The prompt may redraw on the same terminal row, leaving
  // trailing characters from the progress message that look like typed input.
  await ensureSshControlMaster(options.host)

  const runRemote = (command: string) =>
    runProcess('ssh', [
      ...SSH_CONTROL_CLIENT_ARGS,
      options.host,
      buildRemoteShellCommand(command),
    ])

  progress?.onProgress?.('Validating SSH connectivity')
  await runRemote('printf %s ok')

  progress?.onProgress?.('Resolving remote project root')
  const remoteCwd = await resolveRemoteCwd(runRemote, options.cwd)
  const workspace = new RemoteWorkspaceSession(
    options.host,
    remoteCwd,
    false,
    [...SSH_CONTROL_CLIENT_ARGS],
  )

  return {
    remoteCwd,
    workspace,
    close() {
      workspace.close()
      void closeSshControlMaster(options.host)
    },
  }
}

export function createLocalSSHSession(
  options: CommonSessionOptions,
): SSHSession {
  const remoteCwd = resolveLocalPath(options.cwd ?? process.cwd())
  const workspace = new RemoteWorkspaceSession('local', remoteCwd, true)

  return {
    remoteCwd,
    workspace,
    close() {
      workspace.close()
    },
  }
}