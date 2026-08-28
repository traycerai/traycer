import {
  commitHostInstallSource,
  currentInstallPlatform,
  discardStagedHostInstallSource,
  stageHostInstallSource,
  type InstallSourceArg,
} from "../installer";
import { assertHostNotBusy } from "../host/busy-check";
import {
  formatCredentialProvisionNote,
  maybeProvisionCredential,
  runSignInPreflight,
} from "../host/install-auth";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../runner/runner";
import {
  createServiceController,
  formatServiceLifecycleWarning,
  serviceLabelFor,
} from "../service";
import {
  createBytesOnlyInstallLifecycle,
  createServiceInstallLifecycle,
  type ServiceInstallLifecycleHandle,
} from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";

// `traycer host install [--release <version>]` - registry path (NP-4) /
// `--from <path>` local-file path (NP-2). There is NO positional argument:
// bare `install` means latest, and a pin is spelled `--release <version>`
// (the root `--version` collision is why it isn't `--version`). Recovery
// text elsewhere in the CLI must use those two spellings - `host install
// latest` is rejected by Commander as an excess argument.
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
//
// Sign-in pre-flight (client/host token split): the started host reads its
// owner from the shared credentials file, so installing while signed out
// stands up a host that denies every connection ("unprovisioned"). Before
// staging anything, a signed-out interactive run is offered the device-flow
// sign-in inline; a run that cannot prompt (JSON mode - every Desktop/Doctor
// shellout - CI, or a non-TTY stdout) warns and continues instead, and so
// does a declined or failed sign-in. Install-now-login-later stays legal
// throughout: the host picks up a later `traycer login` within one
// connection, no reinstall needed, which is why the guard never hard-fails.
// `--no-service-register` skips the pre-flight entirely - bytes-only,
// nothing is started, and the actor that later starts the service owns the
// sign-in question.
//
// Post-install credential provisioning: a signed-in install that started a
// host follows up with a short-lived stream connection carrying the CLI mint
// flow (`provisionInstalledHostCredential`), so the host comes up holding its
// own `aud: "host"` credential instead of waiting for the first minting
// client. Best-effort and deadline-bounded; failures warn.
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
  // archive simply lands as `activationUnknown` debt. Truly bytes-only:
  // no stop, no register/rewrite, no start, even when a service is
  // already registered - `createServiceInstallLifecycle`'s `bootstrap:
  // null` still rewrites and re-loads an EXISTING registration post-
  // swap, which is not what this flag promises.
  readonly noServiceRegister: boolean;
  // Hidden, internal - the CLI-owned pin gate. After acquiring the
  // lock (download/extract already done outside it), immediately
  // before the service stop, probe `assertHostNotBusy`; busy ->
  // `E_HOST_BUSY` with the extracted temp scrubbed. A pin is an
  // explicit one-shot: Defer abandons it, retry re-downloads - there
  // is no durable deferred-pin state the way there is for a staged
  // update.
  readonly ifIdle: boolean;
  // Install even when the host has work in progress: threaded into the
  // service lifecycle so the pre-swap stop skips the cooperative
  // shutdown claim and kills the host process, exactly like
  // `host stop --force`. Without it a busy host denies the claim and
  // the install aborts with `E_HOST_BUSY` - which used to have no
  // supported escape short of `host stop --force` + reinstall.
  // Mutually exclusive with `ifIdle` (one refuses on busy work, the
  // other kills it). Inert on the bytes-only path (`noServiceRegister`):
  // that path performs no stop for force to escalate.
  readonly force: boolean;
}

export function buildHostInstallCommand(args: HostInstallArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    if (args.noServiceRegister && currentInstallPlatform() === "win32") {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host install: --no-service-register is not supported on Windows",
        details: { environment: ctx.runtime.environment },
        exitCode: 1,
      });
    }
    if (args.force && args.ifIdle) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "host install: --force and --if-idle are mutually exclusive; one refuses to disturb in-flight work, the other kills it",
        details: { environment: ctx.runtime.environment },
        exitCode: 1,
      });
    }
    ctx.runtime.logger.info("Host install command started", {
      environment: ctx.runtime.environment,
      sourceKind: args.fromPath !== null ? "local-file" : "registry",
      versionRequest:
        args.fromPath !== null ? "local-file" : args.versionRequest,
      enableLinger: args.enableLinger,
      allowSelfInvocation: args.allowSelfInvocation,
      noServiceRegister: args.noServiceRegister,
      ifIdle: args.ifIdle,
      force: args.force,
    });
    const authPreflight = await runSignInPreflight(ctx, args.noServiceRegister);
    ctx.runtime.logger.info("Host install sign-in pre-flight resolved", {
      environment: ctx.runtime.environment,
      state: authPreflight.state,
      reason: authPreflight.reason,
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

    // `--no-service-register` must be truly bytes-only: no stop, no
    // register/rewrite, no start - even when a service is already
    // registered. `createServiceInstallLifecycle`'s `bootstrap: null`
    // does not satisfy that (it still rewrites and re-loads an EXISTING
    // registration post-swap), so this skips the service lifecycle
    // entirely and uses the same bytes-only shape `host ensure` uses
    // for `registerService: false`.
    const handle: ServiceInstallLifecycleHandle | null = args.noServiceRegister
      ? null
      : createServiceInstallLifecycle({
          environment: ctx.runtime.environment,
          bootstrap: {
            enableLinger: args.enableLinger,
            allowSelfInvocation: args.allowSelfInvocation,
          },
          force: args.force,
        });
    const lifecycle =
      handle !== null
        ? handle.lifecycle
        : createBytesOnlyInstallLifecycle(
            createServiceController(),
            serviceLabelFor(ctx.runtime.environment),
          );
    ctx.runtime.logger.debug("Host install command lifecycle created", {
      environment: ctx.runtime.environment,
      bytesOnly: handle === null,
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
            lifecycle,
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
      postSwapAction: handle !== null ? handle.state.postSwapAction : "none",
      hasPostSwapError: handle !== null && handle.state.postSwapError !== null,
    });

    // Post-install credential provisioning: leave the just-started host
    // holding its own `aud: "host"` credential rather than waiting for the
    // first minting client to happen to connect. Only where it can help:
    //   - the service lifecycle actually started/restarted a host
    //     (`postSwapAction`), cleanly - a host that failed its post-swap
    //     start has nothing to dial;
    //   - the pre-flight left us signed in (the mint spends the bearer).
    // Deliberately NOT gated on output mode - `--json` is the automation
    // surface that most needs a credentialed host, and a Desktop shellout
    // racing the GUI's own mint resolves inside the probe (a superseded mint
    // verifies the winner's credential rather than failing).
    // Best-effort throughout: any failure is a warning, never a failed
    // install - an unprovisioned host self-heals on the next minting client.
    const credentialProvision = await maybeProvisionCredential(
      ctx,
      handle !== null && handle.state.postSwapError === null
        ? handle.state.postSwapAction
        : "none",
      authPreflight,
    );
    const lifecycleData =
      handle !== null
        ? {
            priorServiceState: handle.state.priorState,
            stoppedBeforeSwap: handle.state.stoppedBeforeSwap,
            postSwapAction: handle.state.postSwapAction,
            postSwapError: handle.state.postSwapError,
          }
        : null;
    let human = `installed host ${result.record.version} (executable=${result.record.executablePath})`;
    if (handle !== null && handle.state.postSwapError !== null) {
      human = `${human}; ${formatServiceLifecycleWarning(handle.state.postSwapAction, handle.state.postSwapError)}`;
    }
    // Restate the unauthenticated warning on the terminal line - the
    // pre-flight's copy printed before a potentially long download and
    // may have scrolled away.
    if (authPreflight.state === "unauthenticated") {
      human = `${human}; not signed in - the host is unprovisioned until you run \`traycer login\``;
    }
    const provisionNote = formatCredentialProvisionNote(credentialProvision);
    if (provisionNote !== null) {
      human = `${human}; ${provisionNote}`;
    }
    return {
      data: {
        version: result.record.version,
        runtimeVersion: result.record.runtimeVersion,
        installedAt: result.record.installedAt,
        executablePath: result.record.executablePath,
        source: result.record.source,
        archiveSha256: result.record.archiveSha256,
        signatureKeyId: result.record.signatureKeyId,
        sizeBytes: result.record.sizeBytes,
        previousVersion: result.previous?.version ?? null,
        serviceLifecycle: lifecycleData,
        installGeneration: result.installGeneration,
        authPreflight,
        credentialProvision,
      },
      human,
      exitCode: 0,
    };
  };
}
