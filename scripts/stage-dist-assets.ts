import { spawnSync } from 'child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dir: string =
  (import.meta as ImportMeta & { dir?: string; dirname?: string }).dir ??
  (import.meta as ImportMeta & { dir?: string; dirname?: string }).dirname ??
  dirname(fileURLToPath(import.meta.url))

const ROOT = resolve(__dir, '..')
const DIST = resolve(ROOT, 'dist')
const DIST_CLI = resolve(DIST, 'cli.mjs')
const SOURCE_NODE_MODULES = resolve(ROOT, 'node_modules')
const DIST_NODE_MODULES = resolve(DIST, 'node_modules')
const DIST_RUNTIME = resolve(DIST, 'runtime')
const PORTABLE_NODE_VERSION = '22.17.0'
const PORTABLE_NODE_DIST_BASE_URL = 'https://nodejs.org/dist'
const IS_WINDOWS = process.platform === 'win32'
const IS_DARWIN = process.platform === 'darwin'
const ROOT_PACKAGE_MANIFEST = JSON.parse(
  readFileSync(resolve(ROOT, 'package.json'), 'utf-8'),
) as {
  name: string
  version: string
  description?: string
  type?: string
  dependencies?: Record<string, string>
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function moveAsidePath(targetPath: string): string {
  const stalePath = `${targetPath}.stale-${Date.now()}`
  renameSync(targetPath, stalePath)
  console.warn(
    `Warning: moved aside unwritable path ${targetPath} -> ${stalePath}`,
  )
  return stalePath
}

function removePathOrMoveAside(targetPath: string): boolean {
  if (!existsSync(targetPath)) {
    return true
  }

  try {
    rmSync(targetPath, { recursive: true, force: true })
    return true
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code
    if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
      throw error
    }

    try {
      moveAsidePath(targetPath)
      return true
    } catch (renameError) {
      const renameErrorCode = (renameError as NodeJS.ErrnoException).code
      if (renameErrorCode !== 'EACCES' && renameErrorCode !== 'EPERM') {
        throw renameError
      }

      console.warn(
        `Warning: keeping existing unwritable path ${targetPath}; it will be reused as-is.`,
      )
      return false
    }
  }
}

function copyDirectory(sourcePath: string, destinationPath: string): void {
  if (!removePathOrMoveAside(destinationPath)) {
    console.warn(
      `Warning: skipped refreshing ${destinationPath} because it is not writable.`,
    )
    return
  }

  cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    dereference: true,
  })
}

function writeTextFile(
  destinationPath: string,
  contents: string,
  options: { executable?: boolean; windowsLineEndings?: boolean } = {},
): void {
  const newline = options.windowsLineEndings ? '\r\n' : '\n'
  const normalized = contents.trimEnd().replace(/\r?\n/g, newline)

  try {
    writeFileSync(destinationPath, `${normalized}${newline}`)
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code
    if (
      (errorCode !== 'EACCES' && errorCode !== 'EPERM') ||
      !existsSync(destinationPath)
    ) {
      throw error
    }

    moveAsidePath(destinationPath)
    writeFileSync(destinationPath, `${normalized}${newline}`)
  }

  if (options.executable) {
    chmodSync(destinationPath, 0o755)
  }
}

function getInstalledDependencyVersion(packageName: string): string {
  const dependencyPackagePath = resolve(
    SOURCE_NODE_MODULES,
    ...packageName.split('/'),
    'package.json',
  )

  if (!existsSync(dependencyPackagePath)) {
    const declaredVersion = ROOT_PACKAGE_MANIFEST.dependencies?.[packageName]
    if (!declaredVersion) {
      fail(`Dependency ${packageName} was not found in node_modules or package.json.`)
    }

    return declaredVersion
  }

  const installedPackage = JSON.parse(
    readFileSync(dependencyPackagePath, 'utf-8'),
  ) as { version?: string }

  if (!installedPackage.version) {
    fail(`Dependency ${packageName} is missing a version field.`)
  }

  return installedPackage.version
}

function getPortablePackageJsonContents(): string {
  const dependencyNames = Object.keys(ROOT_PACKAGE_MANIFEST.dependencies ?? {}).sort()
  const exactDependencies = Object.fromEntries(
    dependencyNames.map(packageName => [
      packageName,
      getInstalledDependencyVersion(packageName),
    ]),
  )

  return JSON.stringify(
    {
      name: `${ROOT_PACKAGE_MANIFEST.name}-portable`,
      version: ROOT_PACKAGE_MANIFEST.version,
      private: true,
      description: ROOT_PACKAGE_MANIFEST.description,
      type: ROOT_PACKAGE_MANIFEST.type ?? 'module',
      dependencies: exactDependencies,
    },
    null,
    2,
  )
}

function findExecutable(command: string): string | undefined {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(locator, [command], { encoding: 'utf-8' })
  if (result.status !== 0) {
    return undefined
  }

  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
}

function resolveRuntimePath(command: string): string | undefined {
  const execName = basename(process.execPath).toLowerCase()
  if (execName === command || execName === `${command}.exe`) {
    return process.execPath
  }

  return findExecutable(command)
}

function stageRuntime(command: string): string | undefined {
  const runtimePath = resolveRuntimePath(command)
  if (!runtimePath || !existsSync(runtimePath)) {
    return undefined
  }

  mkdirSync(DIST_RUNTIME, { recursive: true })
  const fileName = process.platform === 'win32' ? `${command}.exe` : command
  const destinationPath = resolve(DIST_RUNTIME, fileName)

  cpSync(runtimePath, destinationPath, { force: true })
  chmodSync(destinationPath, 0o755)

  return fileName
}

function getUnixLauncherContents(nodeRuntime?: string, bunRuntime?: string): string {
  const runtimeChecks = [
    'if [[ -x "$SCRIPT_DIR/runtime/node-dist/bin/node" ]]; then\n  exec "$SCRIPT_DIR/runtime/node-dist/bin/node" "$SCRIPT_DIR/cli.mjs" "$@"\nfi',
    nodeRuntime
      ? `if [[ -x "$SCRIPT_DIR/runtime/${nodeRuntime}" ]]; then\n  exec "$SCRIPT_DIR/runtime/${nodeRuntime}" "$SCRIPT_DIR/cli.mjs" "$@"\nfi`
      : '',
    bunRuntime
      ? `if [[ -x "$SCRIPT_DIR/runtime/${bunRuntime}" ]]; then\n  exec "$SCRIPT_DIR/runtime/${bunRuntime}" "$SCRIPT_DIR/cli.mjs" "$@"\nfi`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    '',
    runtimeChecks,
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$SCRIPT_DIR/cli.mjs" "$@"',
    'fi',
    '',
    'if command -v bun >/dev/null 2>&1; then',
    '  exec bun "$SCRIPT_DIR/cli.mjs" "$@"',
    'fi',
    '',
    'echo "claude requires a bundled or system node/bun runtime." >&2',
    'exit 1',
  ]
    .filter(Boolean)
    .join('\n')
}

function getWindowsLauncherContents(): string {
  const lines = [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    '',
    'if exist "%SCRIPT_DIR%runtime\\node-dist\\node.exe" (',
    '  "%SCRIPT_DIR%runtime\\node-dist\\node.exe" "%SCRIPT_DIR%cli.mjs" %*',
    '  exit /b %errorlevel%',
    ')',
    'if exist "%SCRIPT_DIR%runtime\\node.exe" (',
    '  "%SCRIPT_DIR%runtime\\node.exe" "%SCRIPT_DIR%cli.mjs" %*',
    '  exit /b %errorlevel%',
    ')',
    'if exist "%SCRIPT_DIR%runtime\\bun.exe" (',
    '  "%SCRIPT_DIR%runtime\\bun.exe" "%SCRIPT_DIR%cli.mjs" %*',
    '  exit /b %errorlevel%',
    ')',
  ]

  lines.push(
    'where node >nul 2>nul',
    'if not errorlevel 1 (',
    '  node "%SCRIPT_DIR%cli.mjs" %*',
    '  exit /b %errorlevel%',
    ')',
    'where bun >nul 2>nul',
    'if not errorlevel 1 (',
    '  bun "%SCRIPT_DIR%cli.mjs" %*',
    '  exit /b %errorlevel%',
    ')',
    'echo claude requires a bundled or system node/bun runtime. 1>&2',
    'exit /b 1',
  )

  return lines.join('\n')
}

function getUnixInstallScriptContents(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'INSTALL_USER=""',
    'INSTALL_HOME=""',
    'INSTALL_SHELL=""',
    'USER_BIN_DIR=""',
    'PATH_TARGET=""',
    'PATH_BLOCK_START="# >>> claude-code >>>"',
    'PATH_BLOCK_END="# <<< claude-code <<<"',
    'NO_MODIFY_PATH=false',
    `PORTABLE_NODE_VERSION="${PORTABLE_NODE_VERSION}"`,
    `PORTABLE_NODE_DIST_BASE_URL="${PORTABLE_NODE_DIST_BASE_URL}"`,
    'RUNTIME_DOWNLOADED=false',
    'USE_BUNDLED_NPM=false',
    '',
    'usage() {',
    '  cat <<EOF',
    'Claude Code installer',
    '',
    'Usage: ./install.sh [options]',
    '',
    'Options:',
    '  --no-modify-path   Do not append this dist directory to your shell profile',
    '  -h, --help         Show this help message',
    'EOF',
    '}',
    '',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    --no-modify-path)',
    '      NO_MODIFY_PATH=true',
    '      shift',
    '      ;;',
    '    -h|--help)',
    '      usage',
    '      exit 0',
    '      ;;',
    '    *)',
    '      echo "Unknown option: $1" >&2',
    '      usage >&2',
    '      exit 1',
    '      ;;',
    '  esac',
    'done',
    '',
    'lookup_home_dir() {',
    '  local user_name="$1"',
    '  local home_dir=""',
    '',
    '  if command -v dscl >/dev/null 2>&1; then',
    '    home_dir="$(dscl . -read "/Users/$user_name" NFSHomeDirectory 2>/dev/null | cut -d" " -f2-)"',
    '  elif command -v getent >/dev/null 2>&1; then',
    '    home_dir="$(getent passwd "$user_name" | cut -d: -f6)"',
    '  fi',
    '',
    '  if [[ -z "$home_dir" ]]; then',
    '    home_dir="$(eval echo "~$user_name" 2>/dev/null || true)"',
    '  fi',
    '',
    '  if [[ "$home_dir" == "~"* ]]; then',
    '    home_dir=""',
    '  fi',
    '',
    '  if [[ -z "$home_dir" ]]; then',
    '    home_dir="$HOME"',
    '  fi',
    '',
    '  echo "$home_dir"',
    '}',
    '',
    'lookup_shell_name() {',
    '  local user_name="$1"',
    '  local shell_path=""',
    '',
    '  if command -v dscl >/dev/null 2>&1; then',
    '    shell_path="$(dscl . -read "/Users/$user_name" UserShell 2>/dev/null | cut -d" " -f2-)"',
    '  elif command -v getent >/dev/null 2>&1; then',
    '    shell_path="$(getent passwd "$user_name" | cut -d: -f7)"',
    '  fi',
    '',
    '  if [[ -z "$shell_path" ]]; then',
    '    shell_path="${SHELL:-}"',
    '  fi',
    '',
    '  basename "$shell_path"',
    '}',
    '',
    'resolve_install_target() {',
    '  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then',
    '    INSTALL_USER="$SUDO_USER"',
    '  else',
    '    INSTALL_USER="${USER:-$(id -un)}"',
    '  fi',
    '',
    '  INSTALL_HOME="$(lookup_home_dir "$INSTALL_USER")"',
    '  INSTALL_SHELL="$(lookup_shell_name "$INSTALL_USER")"',
    '  USER_BIN_DIR="$INSTALL_HOME/.local/bin"',
    '  PATH_TARGET="$USER_BIN_DIR"',
    '}',
    '',
    'detect_profile() {',
    '  case "$INSTALL_SHELL" in',
    '    zsh)',
    '      echo "$INSTALL_HOME/.zshrc"',
    '      ;;',
    '    bash)',
    '      if [[ -f "$INSTALL_HOME/.bashrc" ]]; then',
    '        echo "$INSTALL_HOME/.bashrc"',
    '      else',
    '        echo "$INSTALL_HOME/.bash_profile"',
    '      fi',
    '      ;;',
    '    *)',
    '      echo "$INSTALL_HOME/.profile"',
    '      ;;',
    '  esac',
    '}',
    '',
    'maybe_reassign_to_invoking_user() {',
    '  local target_path="$1"',
    '',
    '  if [[ -z "${SUDO_UID:-}" || -z "${SUDO_GID:-}" || ! -e "$target_path" ]]; then',
    '    return',
    '  fi',
    '',
    '  chown -R "$SUDO_UID:$SUDO_GID" "$target_path" 2>/dev/null || true',
    '}',
    '',
    'ensure_user_launcher() {',
    '  mkdir -p "$USER_BIN_DIR"',
    '  rm -f "$USER_BIN_DIR/claude"',
    "  printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' \"exec \\\"$ROOT_DIR/claude\\\" \\\"\\$@\\\"\" > \"$USER_BIN_DIR/claude\"",
    '  chmod +x "$USER_BIN_DIR/claude"',
    '',
    '  if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then',
    '    chown "$SUDO_UID:$SUDO_GID" "$USER_BIN_DIR" 2>/dev/null || true',
    '    chown "$SUDO_UID:$SUDO_GID" "$USER_BIN_DIR/claude" 2>/dev/null || true',
    '  fi',
    '}',
    '',
    'append_path_block() {',
    '  local profile_path="$1"',
    '  mkdir -p "$(dirname "$profile_path")"',
    '  touch "$profile_path"',
    '  if grep -Fq "$PATH_BLOCK_START" "$profile_path"; then',
    '    return',
    '  fi',
    '',
    '  {',
    '    echo',
    '    echo "$PATH_BLOCK_START"',
    '    echo "export PATH=\\"$PATH_TARGET:\\$PATH\\""',
    '    echo "$PATH_BLOCK_END"',
    '  } >> "$profile_path"',
    '}',
    '',
    'download_file() {',
    '  local url="$1"',
    '  local output_path="$2"',
    '  if command -v curl >/dev/null 2>&1; then',
    '    curl -fsSL "$url" -o "$output_path"',
    '    return',
    '  fi',
    '  if command -v wget >/dev/null 2>&1; then',
    '    wget -qO "$output_path" "$url"',
    '    return',
    '  fi',
    '  echo "curl or wget is required to download Node automatically." >&2',
    '  exit 1',
    '}',
    '',
    'detect_linux_node_arch() {',
    '  case "$(uname -m)" in',
    '    x86_64|amd64)',
    '      echo "x64"',
    '      ;;',
    '    aarch64|arm64)',
    '      echo "arm64"',
    '      ;;',
    '    *)',
    '      echo "Unsupported Linux architecture: $(uname -m)" >&2',
    '      exit 1',
    '      ;;',
    '  esac',
    '}',
    '',
    'download_linux_node_runtime() {',
    '  local node_arch archive_name url temp_dir extracted_dir',
    '  if ! command -v tar >/dev/null 2>&1; then',
    '    echo "tar is required to extract the downloaded Node runtime." >&2',
    '    exit 1',
    '  fi',
    '  node_arch="$(detect_linux_node_arch)"',
    '  archive_name="node-v${PORTABLE_NODE_VERSION}-linux-${node_arch}.tar.xz"',
    '  url="${PORTABLE_NODE_DIST_BASE_URL}/v${PORTABLE_NODE_VERSION}/${archive_name}"',
    '  temp_dir="$(mktemp -d)"',
    '  download_file "$url" "$temp_dir/$archive_name"',
    '  tar -xf "$temp_dir/$archive_name" -C "$temp_dir"',
    '  extracted_dir="$temp_dir/node-v${PORTABLE_NODE_VERSION}-linux-${node_arch}"',
    '  if [[ ! -x "$extracted_dir/bin/node" ]]; then',
    '    echo "Downloaded archive did not contain a Linux node binary." >&2',
    '    rm -rf "$temp_dir"',
    '    exit 1',
    '  fi',
    '  mkdir -p "$ROOT_DIR/runtime"',
    '  rm -rf "$ROOT_DIR/runtime/node-dist" "$ROOT_DIR/runtime/node"',
    '  cp -R "$extracted_dir" "$ROOT_DIR/runtime/node-dist"',
    '  ln -sfn "$ROOT_DIR/runtime/node-dist/bin/node" "$ROOT_DIR/runtime/node"',
    '  chmod +x "$ROOT_DIR/runtime/node-dist/bin/node"',
    '  RUNTIME_DOWNLOADED=true',
    '  rm -rf "$temp_dir"',
    '}',
    '',
    'resolve_npm_runner() {',
    '  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then',
    '    USE_BUNDLED_NPM=false',
    '    return',
    '  fi',
    '  if [[ -x "$ROOT_DIR/runtime/node-dist/bin/node" && -f "$ROOT_DIR/runtime/node-dist/lib/node_modules/npm/bin/npm-cli.js" ]]; then',
    '    USE_BUNDLED_NPM=true',
    '    return',
    '  fi',
    '  case "$(uname -s)" in',
    '    Linux)',
    '      echo "No usable node+npm runtime found. Downloading Node ${PORTABLE_NODE_VERSION} for Linux..."',
    '      download_linux_node_runtime',
    '      USE_BUNDLED_NPM=true',
    '      ;;',
    '    *)',
    '      echo "No usable node+npm runtime found. Auto-download from install.sh is currently supported on Linux only." >&2',
    '      exit 1',
    '      ;;',
    '  esac',
    '}',
    '',
    'install_node_modules() {',
    '  if [[ ! -f "$ROOT_DIR/package.json" ]]; then',
    '    echo "package.json was not found next to install.sh." >&2',
    '    exit 1',
    '  fi',
    '  rm -rf "$ROOT_DIR/node_modules"',
    '  if $USE_BUNDLED_NPM; then',
    '    (cd "$ROOT_DIR" && "$ROOT_DIR/runtime/node-dist/bin/node" "$ROOT_DIR/runtime/node-dist/lib/node_modules/npm/bin/npm-cli.js" install --omit=dev --no-audit --no-fund)',
    '    return',
    '  fi',
    '  if ! command -v npm >/dev/null 2>&1; then',
    '    echo "npm was not found even though node is available." >&2',
    '    exit 1',
    '  fi',
    '  (cd "$ROOT_DIR" && npm install --omit=dev --no-audit --no-fund)',
    '}',
    '',
    'if [[ ! -f "$ROOT_DIR/cli.mjs" ]]; then',
    '  echo "cli.mjs was not found next to install.sh." >&2',
    '  exit 1',
    'fi',
    'if [[ ! -f "$ROOT_DIR/package.json" ]]; then',
    '  echo "package.json was not found next to install.sh." >&2',
    '  exit 1',
    'fi',
    '',
    'resolve_install_target',
    '',
    'resolve_npm_runner',
    'install_node_modules',
    'maybe_reassign_to_invoking_user "$ROOT_DIR/node_modules"',
    'maybe_reassign_to_invoking_user "$ROOT_DIR/runtime"',
    'maybe_reassign_to_invoking_user "$ROOT_DIR/package-lock.json"',
    '',
    'chmod +x "$ROOT_DIR/cli.mjs"',
    'if [[ -f "$ROOT_DIR/claude" ]]; then',
    '  chmod +x "$ROOT_DIR/claude"',
    'fi',
    'if [[ -f "$ROOT_DIR/claude.command" ]]; then',
    '  chmod +x "$ROOT_DIR/claude.command"',
    'fi',
    'if [[ -f "$ROOT_DIR/install.sh" ]]; then',
    '  chmod +x "$ROOT_DIR/install.sh"',
    'fi',
    'if [[ -f "$ROOT_DIR/uninstall.sh" ]]; then',
    '  chmod +x "$ROOT_DIR/uninstall.sh"',
    'fi',
    '',
    'ensure_user_launcher',
    '',
    'PROFILE_PATH="$(detect_profile)"',
    'PATH_UPDATED=false',
    'if [[ ":$PATH:" != *":$PATH_TARGET:"* ]] && ! $NO_MODIFY_PATH; then',
    '  append_path_block "$PROFILE_PATH"',
    '  PATH_UPDATED=true',
    'fi',
    '',
    'echo "Claude Code installed in place at: $ROOT_DIR"',
    'echo "Installed launcher: $USER_BIN_DIR/claude -> $ROOT_DIR/claude"',
    'if $PATH_UPDATED; then',
    '  echo "Added $PATH_TARGET to $PROFILE_PATH"',
    '  echo "Open a new shell or run: source $PROFILE_PATH"',
    '  echo "For this shell, run: export PATH=\"$PATH_TARGET:\$PATH\""',
    'elif [[ ":$PATH:" != *":$PATH_TARGET:"* ]]; then',
    '  echo "$PATH_TARGET is not currently on PATH. Add it manually or rerun without --no-modify-path." >&2',
    '  echo "For this shell, run: export PATH=\"$PATH_TARGET:\$PATH\"" >&2',
    'fi',
    'if $RUNTIME_DOWNLOADED; then',
    '  echo "Downloaded Node ${PORTABLE_NODE_VERSION} into $ROOT_DIR/runtime/node-dist"',
    'fi',
    'echo "Installed npm dependencies into $ROOT_DIR/node_modules"',
    '',
    'echo "You can now run: claude"',
  ].join('\n')
}

function getUnixUninstallScriptContents(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'INSTALL_USER=""',
    'INSTALL_HOME=""',
    'USER_BIN_DIR=""',
    'PATH_BLOCK_START="# >>> claude-code >>>"',
    'PATH_BLOCK_END="# <<< claude-code <<<"',
    '',
    'usage() {',
    '  cat <<EOF',
    'Claude Code uninstaller',
    '',
    'Usage: ./uninstall.sh',
    'EOF',
    '}',
    '',
    'if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then',
    '  usage',
    '  exit 0',
    'fi',
    '',
    'lookup_home_dir() {',
    '  local user_name="$1"',
    '  local home_dir=""',
    '',
    '  if command -v dscl >/dev/null 2>&1; then',
    '    home_dir="$(dscl . -read "/Users/$user_name" NFSHomeDirectory 2>/dev/null | cut -d" " -f2-)"',
    '  elif command -v getent >/dev/null 2>&1; then',
    '    home_dir="$(getent passwd "$user_name" | cut -d: -f6)"',
    '  fi',
    '',
    '  if [[ -z "$home_dir" ]]; then',
    '    home_dir="$(eval echo "~$user_name" 2>/dev/null || true)"',
    '  fi',
    '',
    '  if [[ "$home_dir" == "~"* ]]; then',
    '    home_dir=""',
    '  fi',
    '',
    '  if [[ -z "$home_dir" ]]; then',
    '    home_dir="$HOME"',
    '  fi',
    '',
    '  echo "$home_dir"',
    '}',
    '',
    'resolve_install_target() {',
    '  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then',
    '    INSTALL_USER="$SUDO_USER"',
    '  else',
    '    INSTALL_USER="${USER:-$(id -un)}"',
    '  fi',
    '',
    '  INSTALL_HOME="$(lookup_home_dir "$INSTALL_USER")"',
    '  USER_BIN_DIR="$INSTALL_HOME/.local/bin"',
    '}',
    '',
    'remove_path_block() {',
    '  local profile_path="$1"',
    '  local temp_path',
    '',
    '  if [[ ! -f "$profile_path" ]]; then',
    '    return',
    '  fi',
    '',
    '  temp_path="$(mktemp)"',
    "  awk -v start=\"$PATH_BLOCK_START\" -v end=\"$PATH_BLOCK_END\" '",
    '    $0 == start { skip = 1; next }',
    '    $0 == end { skip = 0; next }',
    '    !skip { print }',
    "  ' \"$profile_path\" > \"$temp_path\"",
    '  mv "$temp_path" "$profile_path"',
    '}',
    '',
    'remove_user_launcher() {',
    '  local launcher_path="$USER_BIN_DIR/claude"',
    '  local target_path=""',
    '',
    '  if [[ ! -e "$launcher_path" && ! -L "$launcher_path" ]]; then',
    '    return',
    '  fi',
    '',
    '  if [[ -L "$launcher_path" ]]; then',
    '    target_path="$(readlink "$launcher_path" 2>/dev/null || true)"',
    '    if [[ "$target_path" == "$ROOT_DIR/claude" ]]; then',
    '      rm -f "$launcher_path"',
    '    fi',
    '    return',
    '  fi',
    '',
    '  if grep -Fq "exec \"$ROOT_DIR/claude\" \"\$@\"" "$launcher_path" 2>/dev/null; then',
    '    rm -f "$launcher_path"',
    '  fi',
    '}',
    '',
    'resolve_install_target',
    'remove_path_block "$INSTALL_HOME/.zshrc"',
    'remove_path_block "$INSTALL_HOME/.bashrc"',
    'remove_path_block "$INSTALL_HOME/.bash_profile"',
    'remove_path_block "$INSTALL_HOME/.profile"',
    'remove_user_launcher',
    '',
    'echo "Removed Claude Code launcher and PATH entry for: $ROOT_DIR"',
    'echo "The extracted dist directory remains in place. Delete it manually if you no longer need it."',
    'echo "If your shell is already open, restart it so PATH changes take effect."',
  ].join('\n')
}

function getWindowsInstallScriptContents(): string {
  return String.raw`@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

set "PORTABLE_NODE_VERSION=${PORTABLE_NODE_VERSION}"
set "PORTABLE_NODE_DIST_BASE_URL=${PORTABLE_NODE_DIST_BASE_URL}"
set "RUNTIME_DOWNLOADED=0"
set "USE_BUNDLED_NPM=0"

if /I "%~1"=="--help" goto :usage
if /I "%~1"=="-h" goto :usage
if not "%~1"=="" goto :usage_error

if not exist "%ROOT_DIR%cli.mjs" (
  echo cli.mjs was not found next to install.bat.
  exit /b 1
)
if not exist "%ROOT_DIR%package.json" (
  echo package.json was not found next to install.bat.
  exit /b 1
)

call :resolve_npm_runner
if errorlevel 1 exit /b 1
call :install_node_modules
if errorlevel 1 exit /b 1

set "CLAUDE_CODE_TARGET_DIR=%ROOT_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = [IO.Path]::GetFullPath($env:CLAUDE_CODE_TARGET_DIR); $current = [Environment]::GetEnvironmentVariable('Path', 'User'); $parts = @(); if ($current) { foreach ($part in ($current -split ';')) { if ($part) { $parts += $part } } }; $normalized = @(); foreach ($part in $parts) { try { $normalized += [IO.Path]::GetFullPath($part) } catch { $normalized += $part } }; if ($normalized -notcontains $dir) { $newPath = if ($current -and $current.Trim()) { $current.TrimEnd(';') + ';' + $dir } else { $dir }; [Environment]::SetEnvironmentVariable('Path', $newPath, 'User') }"
if errorlevel 1 (
  echo Failed to update the user PATH.
  exit /b 1
)

echo Claude Code installed in place at: %ROOT_DIR%
if "%RUNTIME_DOWNLOADED%"=="1" echo Downloaded Node %PORTABLE_NODE_VERSION% into %ROOT_DIR%runtime\node-dist
echo Installed npm dependencies into %ROOT_DIR%node_modules
echo Open a new Command Prompt to use: claude
exit /b 0

:resolve_npm_runner
where node >nul 2>nul
if errorlevel 1 goto :check_bundled_runtime
where npm >nul 2>nul
if errorlevel 1 goto :check_bundled_runtime
set "USE_BUNDLED_NPM=0"
exit /b 0

:check_bundled_runtime
if exist "%ROOT_DIR%runtime\node-dist\node.exe" if exist "%ROOT_DIR%runtime\node-dist\node_modules\npm\bin\npm-cli.js" (
  set "USE_BUNDLED_NPM=1"
  exit /b 0
)
echo No usable node+npm runtime found. Downloading Node %PORTABLE_NODE_VERSION% for Windows...
call :download_node_runtime
if errorlevel 1 exit /b 1
set "USE_BUNDLED_NPM=1"
exit /b %errorlevel%

:download_node_runtime
set "NODE_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "NODE_ARCH=%PROCESSOR_ARCHITEW6432%"
if /I "%NODE_ARCH%"=="AMD64" set "NODE_ARCH=x64"
if /I "%NODE_ARCH%"=="ARM64" set "NODE_ARCH=arm64"
if /I not "%NODE_ARCH%"=="x64" if /I not "%NODE_ARCH%"=="arm64" (
  echo Unsupported Windows architecture: %PROCESSOR_ARCHITECTURE%
  exit /b 1
)
set "NODE_ZIP=node-v%PORTABLE_NODE_VERSION%-win-%NODE_ARCH%.zip"
set "NODE_URL=%PORTABLE_NODE_DIST_BASE_URL%/v%PORTABLE_NODE_VERSION%/%NODE_ZIP%"
set "TEMP_DIR=%TEMP%\claude-code-runtime-%RANDOM%%RANDOM%"
set "NODE_ARCHIVE=%TEMP_DIR%\%NODE_ZIP%"
mkdir "%TEMP_DIR%" || exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:NODE_URL -OutFile $env:NODE_ARCHIVE; Expand-Archive -LiteralPath $env:NODE_ARCHIVE -DestinationPath $env:TEMP_DIR -Force; $runtimeRoot = Join-Path $env:ROOT_DIR 'runtime'; $dest = Join-Path $runtimeRoot 'node-dist'; if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }; New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null; Copy-Item -Recurse -Force (Join-Path $env:TEMP_DIR ('node-v' + $env:PORTABLE_NODE_VERSION + '-win-' + $env:NODE_ARCH)) $dest"
if errorlevel 1 (
  if exist "%TEMP_DIR%" rmdir /S /Q "%TEMP_DIR%"
  echo Failed to download or extract Node runtime from nodejs.org.
  exit /b 1
)
if not exist "%ROOT_DIR%runtime\node-dist\node.exe" (
  if exist "%TEMP_DIR%" rmdir /S /Q "%TEMP_DIR%"
  echo Downloaded archive did not contain node.exe.
  exit /b 1
)
set "RUNTIME_DOWNLOADED=1"
if exist "%TEMP_DIR%" rmdir /S /Q "%TEMP_DIR%"
exit /b 0

:install_node_modules
if exist "%ROOT_DIR%node_modules" rmdir /S /Q "%ROOT_DIR%node_modules"
pushd "%ROOT_DIR%"
if "%USE_BUNDLED_NPM%"=="1" (
  "%ROOT_DIR%runtime\node-dist\node.exe" "%ROOT_DIR%runtime\node-dist\node_modules\npm\bin\npm-cli.js" install --omit=dev --no-audit --no-fund
) else (
  npm install --omit=dev --no-audit --no-fund
)
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
exit /b %INSTALL_EXIT%

:usage
echo Claude Code installer
echo.
echo Usage: install.bat
exit /b 0

:usage_error
echo.
echo Usage: install.bat
exit /b 1`
}

function getWindowsUninstallScriptContents(): string {
  return String.raw`@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"

if /I "%~1"=="--help" goto :usage
if /I "%~1"=="-h" goto :usage
if not "%~1"=="" goto :usage_error

set "CLAUDE_CODE_TARGET_DIR=%ROOT_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = [IO.Path]::GetFullPath($env:CLAUDE_CODE_TARGET_DIR); $current = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $current) { exit 0 }; $parts = @(); foreach ($part in ($current -split ';')) { if ($part) { $parts += $part } }; $filtered = foreach ($part in $parts) { try { if ([IO.Path]::GetFullPath($part) -ne $dir) { $part } } catch { if ($part -ne $dir) { $part } } }; [Environment]::SetEnvironmentVariable('Path', ($filtered -join ';'), 'User')"
if errorlevel 1 (
  echo Failed to update the user PATH.
  exit /b 1
)

echo Removed Claude Code PATH entry for: %ROOT_DIR%
echo The extracted dist directory remains in place. Delete it manually if you no longer need it.
echo Open a new Command Prompt so the PATH change takes effect.
exit /b 0

:usage
echo Claude Code uninstaller
echo.
echo Usage: uninstall.bat
exit /b 0

:usage_error
echo.
echo Usage: uninstall.bat
exit /b 1`
}

function writePortableReadme(): void {
  const lines = [
    'This dist directory is self-contained for the current build platform.',
    '',
    '- Use ./claude on macOS/Linux or claude.cmd on Windows.',
    '- Use install.sh/install.bat and uninstall.sh/uninstall.bat from this dist directory; root-level install scripts are no longer shipped.',
    '- The extracted dist directory is the install root. The installers work in place and do not copy it into a second install directory.',
    `- install.sh on Linux and install.bat on Windows ensure a usable node+npm runtime. When needed, they download Node ${PORTABLE_NODE_VERSION} from nodejs.org.`,
    '- After runtime setup, the installers run npm install in this dist directory to refresh node_modules for the target OS/CPU.',
    '- Linux auto-download requires network access plus curl or wget and tar. Windows auto-download uses PowerShell with network access.',
    '- Build separately on each target OS/CPU because native modules in node_modules are platform-specific.',
    IS_WINDOWS
      ? '- This build can stage Windows runtimes in dist/runtime when node.exe or bun.exe are available during the build.'
      : '- This build does not include Windows runtimes. Run the build on Windows if you need dist/runtime/node.exe or bun.exe.',
    !IS_WINDOWS
      ? '- Linux and macOS launchers are emitted here, but their bundled runtime is only for the current host platform.'
      : '- Non-Windows runtimes are not bundled here; build on the target Unix platform for a self-contained Unix runtime.',
  ]

  writeTextFile(resolve(DIST, 'README-portable.txt'), lines.join('\n'))
}

function main(): void {
  if (!existsSync(DIST_CLI)) {
    fail('dist/cli.mjs not found. Run bun run build-bundle first.')
  }

  if (!existsSync(SOURCE_NODE_MODULES)) {
    fail('node_modules not found. Run bun install first.')
  }

  mkdirSync(DIST, { recursive: true })
  copyDirectory(SOURCE_NODE_MODULES, DIST_NODE_MODULES)
  writeTextFile(resolve(DIST, 'package.json'), getPortablePackageJsonContents())

  const runtimeWritable = removePathOrMoveAside(DIST_RUNTIME)
  if (!runtimeWritable) {
    console.warn(
      `Warning: skipped refreshing ${DIST_RUNTIME} because it is not writable.`,
    )
  }

  const nodeRuntime = runtimeWritable ? stageRuntime('node') : undefined
  const bunRuntime = runtimeWritable ? stageRuntime('bun') : undefined

  const unixLauncher = getUnixLauncherContents(nodeRuntime, bunRuntime)
  writeTextFile(resolve(DIST, 'claude'), unixLauncher, { executable: true })
  if (IS_DARWIN) {
    writeTextFile(resolve(DIST, 'claude.command'), unixLauncher, { executable: true })
  } else {
    rmSync(resolve(DIST, 'claude.command'), { force: true })
  }

  writeTextFile(resolve(DIST, 'claude.cmd'), getWindowsLauncherContents(), {
    windowsLineEndings: true,
  })
  writeTextFile(resolve(DIST, 'install.sh'), getUnixInstallScriptContents(), {
    executable: true,
  })
  writeTextFile(resolve(DIST, 'uninstall.sh'), getUnixUninstallScriptContents(), {
    executable: true,
  })
  writeTextFile(resolve(DIST, 'install.bat'), getWindowsInstallScriptContents(), {
    windowsLineEndings: true,
  })
  writeTextFile(resolve(DIST, 'uninstall.bat'), getWindowsUninstallScriptContents(), {
    windowsLineEndings: true,
  })
  writePortableReadme()

  console.log('Staged portable dist assets:')
  console.log(`  bundle:       ${DIST_CLI}`)
  console.log(`  manifest:     ${resolve(DIST, 'package.json')}`)
  console.log(`  node_modules: ${DIST_NODE_MODULES}`)
  if (nodeRuntime) {
    console.log(`  runtime:      ${resolve(DIST_RUNTIME, nodeRuntime)}`)
  }
  if (bunRuntime) {
    console.log(`  runtime:      ${resolve(DIST_RUNTIME, bunRuntime)}`)
  }
  console.log(`  launcher:     ${resolve(DIST, 'claude')}`)
  console.log(`  launcher:     ${resolve(DIST, 'claude.cmd')}`)
  console.log(`  installer:    ${resolve(DIST, 'install.sh')}`)
  console.log(`  installer:    ${resolve(DIST, 'install.bat')}`)
}

main()