import {
  installHost,
  type InstallSourceArg,
} from "../installer";
import type { CommandFn, CommandResult } from "../runner/runner";
import { formatServiceLifecycleWarning } from "../service";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";

// `traycer host install <version|latest>` - registry path (NP-4) /
// `--from <path>` local-file path (NP-2). Both serialise on the
// per-environment CLI lock so a parallel Desktop window or terminal can't
// corrupt the install dir mid-write.
//
// Lifecycle ordering (Tech Plan, Decision 3): stage + verify + extract
// happen before we touch the OS service. Only once the new bytes are
// proven good do we stop the running host, swap the install dir, and
// start/restart the service. If the post-swap start fails the new
// host stays installed (no rollback) - Doctor surfaces the
// non-readiness to the operator.
//
// Clean-machine bootstrap (Core Flow 1 / Flow 7): when no OS service is
// registered yet (`priorState === "not-installed"`), the lifecycle
// registers + starts the service post-swap so a single
// `traycer host install` end-to-end stands up the host without
// needing Desktop or a separate `traycer host service install` step. The
// `--allow-self-invocation` flag is forwarded to
// `resolveServiceCliInvocation` so dev / local-file installs that pre-
// date the packaged CLI (NP-3) can still register a working service.
export interface HostInstallArgs {
  // Always a concrete version token - "latest" or a semver. A local
  // file is signalled by a non-null `fromPath` and supersedes
  // `versionRequest`. The entrypoint resolves "" / null at the
  // registration site so command body callers never see ambiguity.
  readonly versionRequest: string;
  readonly fromPath: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
}

export function buildHostInstallCommand(args: HostInstallArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host install command started", {
      environment: ctx.runtime.environment,
      sourceKind: args.fromPath !== null ? "local-file" : "registry",
      versionRequest: args.fromPath !== null ? "local-file" : args.versionRequest,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
    });
    const source: InstallSourceArg =
      args.fromPath !== null
        ? { kind: "local-file", path: args.fromPath }
        : {
            kind: "registry",
            versionRequest: args.versionRequest,
          };
    const handle = createServiceInstallLifecycle({
      environment: ctx.runtime.environment,
      bootstrap: {
        enableLinger: args.enableLinger,
        allowSelfInvocation: args.allowSelfInvocation,
      },
    });
    ctx.runtime.logger.debug("Host install command lifecycle created", {
      environment: ctx.runtime.environment,
    });
    const result = await withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-install",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () =>
        installHost({
          environment: ctx.runtime.environment,
          source,
          onProgress: (info) => ctx.progress(info),
          lifecycle: handle.lifecycle,
          // `host install` records the registry version or the derived
          // local-file version - it is not stamping this build's identity.
          recordVersionOverride: null,
        }),
    );
    ctx.runtime.logger.info("Host install command completed", {
      environment: ctx.runtime.environment,
      version: result.record.version,
      previousVersion: result.previous?.version ?? null,
      postSwapAction: handle.state.postSwapAction,
      hasPostSwapError: handle.state.postSwapError !== null,
    });
    const lifecycleData = {
      priorServiceState: handle.state.priorState,
      stoppedBeforeSwap: handle.state.stoppedBeforeSwap,
      postSwapAction: handle.state.postSwapAction,
      postSwapError: handle.state.postSwapError,
    };
    return {
      data: {
        version: result.record.version,
        installedAt: result.record.installedAt,
        executablePath: result.record.executablePath,
        source: result.record.source,
        archiveSha256: result.record.archiveSha256,
        signatureKeyId: result.record.signatureKeyId,
        sizeBytes: result.record.sizeBytes,
        previousVersion: result.previous?.version ?? null,
        serviceLifecycle: lifecycleData,
      },
      human:
        handle.state.postSwapError !== null
          ? `installed host ${result.record.version} (executable=${result.record.executablePath}); ${formatServiceLifecycleWarning(handle.state.postSwapAction, handle.state.postSwapError)}`
          : `installed host ${result.record.version} (executable=${result.record.executablePath})`,
      exitCode: 0,
    };
  };
}
