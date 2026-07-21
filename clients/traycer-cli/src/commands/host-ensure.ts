import { ensureHost, type HostEnsureResult } from "../host/ensure";
import type { CommandFn, CommandResult } from "../runner/runner";
import { formatServiceLifecycleWarning } from "../service";

// `traycer host ensure [--release <v> | --from <path>]` - idempotent
// "make the host installed + registered + running" command. This is
// the single host-lifecycle call the desktop shell makes after the
// user signs in; the desktop never registers services or calls launchctl
// itself. See host/ensure.ts for the source-resolution order and the
// state machine.
export interface HostEnsureArgs {
  readonly versionRequest: string | null;
  readonly fromPath: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // Install the host bytes only; leave OS-service registration to the
  // host. The desktop passes this because it registers the macOS login
  // item via SMAppService (only the .app can attribute the row).
  readonly noServiceRegister: boolean;
  // Skip the busy check and restart a running host unconditionally
  // (desktop "Force restart" path). Surfaced as `--force`.
  readonly force: boolean;
}

export function buildHostEnsureCommand(args: HostEnsureArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const result = await ensureHost({
      runtime: ctx.runtime,
      versionRequest: args.versionRequest,
      fromPath: args.fromPath,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
      noServiceRegister: args.noServiceRegister,
      force: args.force,
      onProgress: (info) => ctx.progress(info),
    });
    return {
      data: {
        installed: result.installed,
        registered: result.registered,
        running: result.running,
        version: result.version,
        runtimeVersion: result.runtimeVersion,
        action: result.action,
        serviceLifecycle: result.serviceLifecycle,
        postSwapError: result.postSwapError,
        installGeneration: result.installGeneration,
      },
      human: buildHuman(result),
      exitCode: 0,
    };
  };
}

function buildHuman(result: HostEnsureResult): string {
  const base = describeAction(result);
  if (result.postSwapError !== null && result.serviceLifecycle !== null) {
    return `${base}; ${formatServiceLifecycleWarning(result.serviceLifecycle.postSwapAction, result.postSwapError)}`;
  }
  return base;
}

function describeAction(result: HostEnsureResult): string {
  // Prefer the archive's own build stamp: `version` is the caller's
  // idempotency identity and can lag the installed bytes when an older CLI
  // installs a newer archive (the echo then names a build that isn't the
  // one that just started).
  const version = result.runtimeVersion ?? result.version ?? "unknown";
  switch (result.action) {
    case "noop":
      return `host already ready (version=${version})`;
    case "installed":
      return `installed and started host ${version}`;
    case "service-registered":
      return `registered and started the OS service for installed host ${version}`;
    case "started":
      return `started the registered host service (version=${version})`;
  }
}
