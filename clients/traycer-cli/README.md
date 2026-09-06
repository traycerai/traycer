# @traycerai/cli

The npm distribution of the Traycer command line tool.

Traycer Desktop already includes the CLI and runs it behind the scenes, so most people do not need to install this package directly. Install `@traycerai/cli` when you want to manage the local Traycer Host from a terminal, script Traycer workflows, or use the agent/workspace automation surface outside the desktop app.

The npm package is a fully bundled JavaScript build with no runtime npm dependencies. It runs on Node.js 20.18.1 or newer.

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
| `traycer logout`               | Sign out and delete locally cached published-chat content.             |
| `traycer whoami`               | Validate the stored credentials and show the signed-in user.           |
| `traycer host ensure`          | Install, register, and start the local Traycer Host if needed.         |
| `traycer host status`          | Show host process, endpoint, and activity status.                      |
| `traycer host service start`   | Start the registered background host service and return.               |
| `traycer host stop`            | Stop the running host.                                                 |
| `traycer host doctor`          | Diagnose host installation and runtime issues.                         |
| `traycer host logs --tail 200` | Print recent host logs.                                                |
| `traycer host update`          | Update the installed host to the latest compatible release.            |
| `traycer host available`       | List host versions available for this environment.                     |
| `traycer cli upgrade`          | Upgrade the installed CLI binary when supported by the install source. |
| `traycer config shell get`     | Show the shell used for host bootstrap and terminal tabs.              |
| `traycer config env list`      | Show environment overrides used by Traycer.                            |

`traycer host start` is the **foreground** supervisor - it runs the host in this
terminal and blocks until the host exits. It is also the entrypoint launchd /
systemd / Scheduled Tasks invoke. Interactive runs print a banner naming the log
file and how to stop; use `traycer host logs --follow` in another terminal to
watch the log. To start the background service and get your prompt back, use
`traycer host service start`.

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

Traycer-launched agent sessions receive environment variables such as `TRAYCER_AGENT_ID` and `TRAYCER_EPIC_ID`. In that context, the CLI can inspect the current Task, communicate with other agents, and create worktrees:

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

### Stopping the host from inside Traycer

The commands that stop the host - `host update`, `host apply`, `host install`,
`host ensure`, `host restart`, `host stop`, `host uninstall`,
`host free-port-and-restart` and `host service uninstall` - are frequently run
by the host itself, or by a person in a terminal the host opened. On those runs
the command is a child of the host, so a naive stop kills the command that
issued it, part-way through its own work.

On Linux the CLI re-runs such a command in a transient systemd scope of its own
(`systemd-run --user --scope`) before the command body starts. The relocated
process is a sibling of `ai.traycer.host.service` rather than a child of it, and
survives the stop. The relocated CLI reports back to the process that launched
it as soon as it starts, and only then is the move recorded in the CLI log as
`relocated host-stopping command into a transient scope`.

Every way that can fail leaves the host running and reports
`E_SERVICE_CONTROL_FAILED` rather than proceeding:

- `systemd-run` is missing, or starts and then exits before the command does -
  there is no systemd user manager, or the transient scope was refused;
- the CLI cannot read its own `/proc/self/cgroup`. An absent file (a container,
  or WSL without systemd) means nothing can kill the command and it simply runs;
  a file that exists but cannot be read says nothing either way, and is treated
  as a failed check rather than permission to proceed;
- an argument contains `$`. systemd 258 expands variables in scope arguments by
  default, and the option to turn that off does not exist before systemd 254, so
  a path such as `--from '/tmp/${BUILD}/host.tar.gz'` is refused instead of being
  silently rewritten;
- the stop is reached with the CLI still inside the host's own unit. This is
  checked again immediately before the host is stopped, so a scope that did not
  actually move the process is caught even if everything above appeared to work.

In each case, run the command again from a shell outside Traycer.

On Windows there is no re-exec. The host's processes are terminated
individually, and the CLI running the command, its children, and the shell that
launched it are excluded from that set - terminating the host's whole tree would
take them down with it.

macOS needs neither: stopping the host's launchd job does not touch the CLI.

## Links

- Documentation: [docs.traycer.ai](https://docs.traycer.ai)
- Desktop app: [traycer.ai/download](https://traycer.ai/download)
- Source code: [github.com/traycerai/traycer](https://github.com/traycerai/traycer)
- CLI 1.0.0 release notes: [github.com/traycerai/traycer/releases/tag/cli-v1.0.0](https://github.com/traycerai/traycer/releases/tag/cli-v1.0.0)

## License

MIT. See the repository [LICENSE](https://github.com/traycerai/traycer/blob/main/LICENSE).
