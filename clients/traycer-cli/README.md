# @traycerai/cli

The npm distribution of the Traycer command line tool.

Traycer Desktop already includes the CLI and runs it behind the scenes, so most people do not need to install this package directly. Install `@traycerai/cli` when you want to manage the local Traycer Host from a terminal, script Traycer workflows, or use the agent/workspace automation surface outside the desktop app.

The npm package is a fully bundled JavaScript build with no runtime npm dependencies. It runs on Node.js 20.18.0 or newer.

## Installation

```sh
npm install -g @traycerai/cli
```

You can also run it without a global install:

```sh
npx @traycerai/cli --help
```

For the full desktop app, install Traycer from [traycer.ai/download](https://traycer.ai/download).

## Quick Start

```sh
traycer login
traycer host ensure
traycer host status
```

`traycer login` starts the browser-based sign-in flow. `traycer host ensure` installs the host version supported by this CLI, registers it with the operating system service manager when needed, and starts it. `traycer host status` confirms the local host process and endpoint.

## What It Does

- **Host lifecycle:** download, verify, install, start, stop, update, and supervise the local Traycer Host.
- **Authentication:** sign in with OAuth PKCE and share credentials with Traycer Desktop.
- **Diagnostics:** inspect host status, logs, service registration, and setup problems.
- **Configuration:** manage shell selection and environment overrides used by host and agent sessions.
- **Workspaces:** list Traycer workspaces and create isolated Git worktrees.
- **Agent automation:** list, create, message, and inspect agents from Traycer-managed sessions.

## Common Commands

| Command                        | Purpose                                                                |
| ------------------------------ | ---------------------------------------------------------------------- |
| `traycer login`                | Sign in to Traycer.                                                    |
| `traycer logout`               | Remove locally stored credentials.                                     |
| `traycer whoami`               | Show the signed-in user.                                               |
| `traycer host ensure`          | Install, register, and start the local Traycer Host if needed.         |
| `traycer host status`          | Show host process, endpoint, and activity status.                      |
| `traycer host doctor`          | Diagnose host installation and runtime issues.                         |
| `traycer host logs --tail 200` | Print recent host logs.                                                |
| `traycer host update`          | Update the installed host to the latest compatible release.            |
| `traycer host available`       | List host versions available for this environment.                     |
| `traycer cli upgrade`          | Upgrade the installed CLI binary when supported by the install source. |
| `traycer config shell get`     | Show the shell used for host bootstrap and terminal tabs.              |
| `traycer config env list`      | Show environment overrides used by Traycer.                            |

Use `--help` on any command group for the full local reference:

```sh
traycer --help
traycer host --help
traycer agent --help
```

## Scripting

```sh
traycer host status --json
```

Most commands support `--json`, which emits structured NDJSON events suitable for automation. The CLI also supports `--quiet` and `--no-progress` for logs, and honors non-interactive environments such as CI.

## Agent and Workspace Commands

Traycer-launched agent sessions receive environment variables such as `TRAYCER_AGENT_ID` and `TRAYCER_EPIC_ID`. In that context, the CLI can inspect the current epic, communicate with other agents, and create worktrees:

```sh
traycer agent list
traycer agent inbox
traycer agent send --to <agent-id> --message "Can you review this change?"
traycer workspace list
traycer worktree create --workspace /path/to/repo --branch my-feature
```

These commands are mainly intended for Traycer-managed automation, but they are regular CLI commands and can be scripted when the host is running and the required IDs are supplied.

## Host Security

The npm package ships the CLI bundle only. The Traycer Host is a separate signed binary distributed through GitHub Releases. Before installation, host archives are verified by checksum and minisign signature against the trust root embedded in the CLI.

On supported platforms, the CLI supervises the host through the operating system service manager, including launchd on macOS and systemd user services on Linux.

## Authentication and Local Files

Sign-in uses OAuth with PKCE on a local loopback callback. Credentials and CLI state are stored under your Traycer home directory, including shared auth state used by Traycer Desktop.

Provider API keys are not configured through this CLI. Configure providers in Traycer Desktop under Settings > Providers.

## Troubleshooting

Start with:

```sh
traycer host doctor
traycer host logs --tail 200
```

If the host is missing or stopped, run:

```sh
traycer host ensure
```

If the service is registered but not responding, restart it:

```sh
traycer host restart
```

## Links

- Documentation: [docs.traycer.ai](https://docs.traycer.ai)
- Desktop app: [traycer.ai/download](https://traycer.ai/download)
- Source code: [github.com/traycerai/traycer](https://github.com/traycerai/traycer)
- CLI 1.0.0 release notes: [github.com/traycerai/traycer/releases/tag/cli-v1.0.0](https://github.com/traycerai/traycer/releases/tag/cli-v1.0.0)

## License

Apache-2.0. See the repository [LICENSE](https://github.com/traycerai/traycer/blob/main/LICENSE).
