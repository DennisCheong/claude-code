# Claude Code BYOK

Claude Code is a terminal-based CLI for interacting with Claude from the command line. It supports file editing, shell command execution, codebase search, git workflow tasks, and related developer workflows.

This repository is a fork of [codeaashu/claude-code](https://github.com/codeaashu/claude-code) and contains the project source and supporting documentation.
It adds BYOK (bring your own key) support through `claude-config.json`, including per-model provider configuration and a built-in `/models` slash command for switching the active Opus, Sonnet, and Haiku models.
This fork also adds `claude ssh`, which keeps the Claude runtime local while attaching to a remote Linux workspace over SSH, with `#` for remote shell commands and `$path` for remote file references.

### Third-Party Model Setup

1. Create or edit `claude-config.json` in the repository root.
2. Add each model under `models` and set its own `provider` value.
3. Use `provider: "openai-compatible"` for third-party endpoints.
4. Set `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, `env.ANTHROPIC_DEFAULT_SONNET_MODEL`, and `env.ANTHROPIC_DEFAULT_HAIKU_MODEL` to the `modelId` values you want Claude Code to use.
5. Provide the OpenAI-compatible API details with environment variables such as `OPENAI_COMPATIBLE_API_KEY` and `OPENAI_COMPATIBLE_BASE_URL`.
6. Use `/models` inside the CLI to update the Opus, Sonnet, and Haiku roles later without editing the file by hand.

Example:

```json
{
	"env": {
		"OPENAI_COMPATIBLE_API_KEY": "your-api-key",
		"OPENAI_COMPATIBLE_BASE_URL": "https://example.com/v1/chat/completions",
		"ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen3.6-plus",
		"ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3.6-plus",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen3.6-plus"
	},
	"models": [
		{
			"provider": "openai-compatible",
			"modelId": "qwen3.6-plus",
			"name": "Qwen3.6 Plus",
			"capabilities": {
				"thinking": true,
				"effort": true,
				"structuredOutputs": true,
				"webSearch": true,
				"tools": true,
				"vision": true
			},
			"contextWindow": 1000000,
			"maxOutput": 65536
		}
	]
}
```

The `capabilities` block lets you declare support for features like thinking, effort, structured outputs, web search, tools, and vision. For third-party models, startup no longer needs Anthropic connectivity when the active provider is openai-compatible.

## Build

```bash
bun install
bun run build
```

`bun run build` produces the portable `dist/` bundle for the current platform, including `dist/cli.mjs`, `dist/package.json`, `dist/install.sh`, `dist/uninstall.sh`, `dist/install.bat`, and `dist/uninstall.bat`.

If you want the repo scripts that also copy `claude-config.json` into `dist/`, use `./build.sh` on macOS/Linux or `build.bat` on Windows.

Build on each target OS/CPU when you need native modules for that platform. `dist/runtime` only includes runtimes for the machine that ran the build.

## Install

Copy or unzip the generated `dist/` directory onto the target machine, then run the installer from inside that directory.

macOS/Linux:

```bash
cd dist
./install.sh
```

Windows:

```bat
cd dist
install.bat
```

The extracted `dist/` directory is the install root. The installer does not move the bundle elsewhere; it keeps the current `dist/` directory in place and creates a user-level `claude` launcher that points back to that directory.

On macOS/Linux, the installer writes a small wrapper to `~/.local/bin/claude` and appends `~/.local/bin` to your shell profile if it is not already on PATH. After installation, open a new shell or run `source ~/.zshrc` (or your shell profile) so the new PATH entry is visible.

On Windows, `install.bat` updates the user PATH to point at the same extracted `dist/` directory in place.

The installer first checks for a usable `node` and `npm`. If they are already available, it skips the runtime download and only runs `npm install` in `dist/` to refresh `node_modules` for the target OS/CPU.

If `node` and `npm` are missing, `dist/install.sh` on Linux and `dist/install.bat` on Windows download Node `22.17.0` from `nodejs.org` before running `npm install`.

Linux auto-download needs network access plus `curl` or `wget` and `tar`. Windows auto-download uses PowerShell.

To remove the PATH entry later, run `dist/uninstall.sh` or `dist/uninstall.bat`. Delete the extracted `dist/` directory manually if you no longer want it.

## Usage

After install, open a new shell or Command Prompt and run:

```bash
claude
```

You can also run the staged launcher directly from the extracted directory:

```bash
dist/claude
```

On Windows, use `dist/claude.cmd`.

Use `claude --help` to see command-line options, and use `/models` inside the CLI to switch Opus, Sonnet, and Haiku models for this fork.

## SSH Remote Workspace Mode

This fork adds a detailed SSH workflow for working on a remote Linux project without moving the Claude runtime off your local machine.

`claude ssh` is a local-runtime, remote-workspace mode:

- Claude, model execution, auth, provider selection, and settings stay on the local machine.
- SSH is only used for remote shell execution, remote file access, remote search/edit operations, and remote project memory loading.
- The remote host does not need direct internet access to call the LLM provider.
- The remote host does not need `claude auth login`, `node`, `bun`, or a bundled Claude runtime.
- Each SSH session attaches to exactly one active remote target.

### Command Syntax

```bash
claude ssh <user@host | ssh-config-alias> [dir]
```

- `<user@host | ssh-config-alias>` is the SSH destination.
- `[dir]` is the remote project root for the session.
- If `[dir]` is omitted, Claude uses the remote shell's current working directory.
- All remote-relative `$path` references resolve against that one active remote root.

Examples:

```bash
claude ssh dev@server
claude ssh dev@server ~/app
claude ssh my-prod-box /srv/service
```

After connection, the session remains local, but the active workspace is the remote directory you attached.

### Namespace Split: Local vs Remote

`claude ssh` introduces two explicit namespaces that do not exist in upstream Claude Code: `#` for remote shell commands and `$` for remote file references.

| Syntax | Scope | Meaning |
| --- | --- | --- |
| `!cmd` | local | Run a local shell command on your machine |
| `#cmd` | remote | Run a remote shell command over SSH |
| `@path` | local | Attach or reference a local file |
| `$path` | remote | Attach or reference a remote file under the active SSH workspace |

These prefixes are intentionally explicit:

- `!` always means local shell.
- `#` always means remote shell.
- `@` always means local file scope.
- `$` always means remote file scope.

This separation matters because the local machine and remote machine can be in completely different directories and have different files.

### `#` Remote Bash Mode

Inside an active SSH session, start a prompt with `#` to run a command on the remote host.

Examples:

```text
#pwd
#ls -la
#git status
```

Behavior:

- `#pwd` runs on the remote host inside the active remote workspace.
- `!pwd` still runs locally on your machine.
- `#` commands are executed over SSH and return their stdout/stderr back into the Claude transcript.
- `#` is only for remote bash commands. It does not mean "comment" or "file reference" in SSH mode.

Typical contrast:

```text
!pwd   # local machine
#pwd   # remote machine
```

Use this when you want Claude to inspect or operate on the remote environment directly, for example checking processes, running tests remotely, or confirming the remote working directory.

### `$` Remote File Mentions

Inside an active SSH session, use `$path` to refer to files or directories in the remote workspace.

Examples:

```text
$README.md summarize this file
$src/main.ts explain this module
$logs/ show this directory
```

Behavior:

- `$README.md` resolves against the active remote root set by `claude ssh <host> [dir]`.
- `$src/main.ts` is read from the remote host, not from your local checkout.
- `$logs/` can refer to a remote directory; Claude will inspect the directory listing rather than treating it as a local folder.
- `@README.md` still refers to a local file even during the same SSH session.

This means local and remote files can be used together in one request without ambiguity.

Cross-scope examples:

```text
@debug.txt copy this content to $debug.txt
Compare @src/config.ts with $src/config.ts
Summarize $note.txt and then patch @notes.md with the summary
```

In other words, `@...` and `$...` are separate namespaces, not aliases.

### Remote Project Memory

When an SSH session is active, project memory is loaded from the remote workspace rather than from the local repository.

Claude reads remote project memory from:

- `.claude/CLAUDE.md`
- `.claude/rules/*.md`

under the active remote root.

This has two important consequences:

- The SSH session uses the remote project's rules and context.
- Your local user settings, local auth, and local model configuration still remain in effect.

### Typical Workflow

1. Attach to a remote workspace:

```bash
claude ssh dev@server ~/app
```

2. Inspect the remote environment:

```text
#pwd
#git status
```

3. Read remote files with `$`:

```text
$package.json summarize dependencies
$src/index.ts explain startup flow
```

4. Mix local and remote context in one prompt when needed:

```text
Compare @package.json with $package.json
Copy @claude-config.json to $claude-config.json
```

5. Keep using `!` for local shell tasks:

```text
!pwd
!git status
```

### Headless SSH Usage

The SSH workspace mode also works with print/headless execution.

Example:

```bash
claude ssh dev@server ~/app -p 'Read the remote file $note.txt, summarize it in one sentence, and state the active SSH workspace path.'
```

This is useful for scripted validation, smoke tests, and non-interactive remote checks.

### Practical Notes

- SSH authentication happens locally through your normal SSH setup, including password prompts or SSH config aliases.
- `claude ssh` keeps one active remote workspace per session; it is not a multi-host mode.
- The remote workspace root controls how relative `$path` values are resolved.
- `!` and `@` continue to target the local machine even while the SSH session is active.
- `#` and `$` only make sense after a `claude ssh` session has been established.
- This design is intended for remote hosts with limited tooling or no outbound internet because the Claude runtime stays local.

## Disclaimer

> This repository archives source code leaked from Anthropic's npm registry on **2026-03-31**. All original source code is the property of [Anthropic](https://www.anthropic.com). This is not an official release and is not licensed for redistribution. Contact [aashuu ✦](https://x.com/warrioraashuu) for any comments.

