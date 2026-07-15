import {
  commitHostInstallSource,
  discardStagedHostInstallSource,
  stageHostInstallSource,
  type InstallSourceArg,
} from "../installer";
import { assertHostNotBusy } from "../host/busy-check";
import type { CommandFn, CommandResult } from "../runner/runner";
import { formatServiceLifecycleWarning } from "../service";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";

// `traycer host install <version|latest>` - registry path (NP-4) /
// `--from <path>` local-file path (NP-2).
//
// Lifecycle ordering (Tech Plan, Decision 3): stage + verify + extract
// happen before we touch the OS service. Only once the new bytes are
// proven good do we stop the running host, swap the install dir, and
// start/restart the service. If the post-swap start fails the new
// host stays installed (no rollback) - Doctor surfaces the
// non-readiness to the operator.
//
// `cli-lock` scope (Tech Plan, "Lock-scope restructure"): download,
// verify, and extract happen into an owner-tokened temp dir OUTSIDE the
// lock (`stageHostInstallSource`), so a parallel Desktop window or
// terminal can't be blocked behind a potentially-long download. Only
// the commit (reconcile -> stop -> swap -> start -> re-reconcile,
// `commitHostInstallSource`) runs inside the lock.
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
  // Install the host bytes only; leave OS-service registration to the
  // host (mirrors `host ensure`'s flag) - the packaged-macOS pin path,
  // where Desktop owns registration via SMAppService. A null-runtime
  // archive simply lands as `activationUnknown` debt.
  readonly noServiceRegister: boolean;
  // Hidden, internal - the CLI-owned pin gate. After acquiring the
  // lock (download/extract already done outside it), immediately
  // before the service stop, probe `assertHostNotBusy`; busy ->
  // `E_HOST_BUSY` with the extracted temp scrubbed. A pin is an
  // explicit one-shot: Defer abandons it, retry re-downloads - there
  // is no durable deferred-pin state the way there is for a staged
  // update.
  readonly ifIdle: boolean;
}

export function buildHostInstallCommand(args: HostInstallArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host install command started", {
      environment: ctx.runtime.environment,
      sourceKind: args.fromPath !== null ? "local-file" : "registry",
      versionRequest:
        args.fromPath !== null ? "local-file" : args.versionRequest,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
      noServiceRegister: args.noServiceRegister,
      ifIdle: args.ifIdle,
    });
    const source: InstallSourceArg =
      args.fromPath !== null
        ? { kind: "local-file", path: args.fromPath }
        : {
            kind: "registry",
            versionRequest: args.versionRequest,
          };

    const staged = await stageHostInstallSource({
      environment: ctx.runtime.environment,
      source,
      onProgress: (info) => ctx.progress(info),
      // `host install` records the registry version or the derived
      // local-file version - it is not stamping this build's identity.
      recordVersionOverride: null,
    });

    const handle = createServiceInstallLifecycle({
      environment: ctx.runtime.environment,
      bootstrap: args.noServiceRegister
        ? null
        : {
            enableLinger: args.enableLinger,
            allowSelfInvocation: args.allowSelfInvocation,
          },
    });
    ctx.runtime.logger.debug("Host install command lifecycle created", {
      environment: ctx.runtime.environment,
    });

    let result;
    try {
      result = await withCliLock(
        {
          environment: ctx.runtime.environment,
          reason: "host-install",
          waitMs: 30_000,
          pollIntervalMs: 100,
        },
        async () => {
          if (args.ifIdle) {
            await assertHostNotBusy(ctx.runtime.environment);
          }
          return commitHostInstallSource({
            environment: ctx.runtime.environment,
            staged,
            onProgress: (info) => ctx.progress(info),
            lifecycle: handle.lifecycle,
          });
        },
      );
    } catch (err) {
      // Any failure that prevented `commitHostInstallSource` from ever
      // running (the busy probe, a cli-lock timeout) leaves the
      // extracted temp orphaned - scrub it (a no-op if
      // `commitHostInstallSource` already cleaned up itself before
      // this error reached us).
      await discardStagedHostInstallSource(ctx.runtime.environment, staged);
      throw err;
    }

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
        installGeneration: result.installGeneration,
      },
      human:
        handle.state.postSwapError !== null
          ? `installed host ${result.record.version} (executable=${result.record.executablePath}); ${formatServiceLifecycleWarning(handle.state.postSwapAction, handle.state.postSwapError)}`
          : `installed host ${result.record.version} (executable=${result.record.executablePath})`,
      exitCode: 0,
    };
  };
}
