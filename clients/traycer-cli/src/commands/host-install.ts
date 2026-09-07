import {
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
import {
  requireCliUpdateMutationCapability,
  withCliAttemptMutation,
  withCliUpdateExecutionSegment,
} from "../host/update-contender";
import { resolveAttemptAdoptionFromNonce } from "../host/update-adoption";
import { hostHomeDir } from "../store/paths";
import { commitHostInstallSourceWithAttempt } from "../host/update-mutation";

// Registry or `--from` install. Runs under cli-lock; busy hosts refuse before the swap.
export interface HostInstallArgs {
  // Always a concrete version token - "latest" or a semver.
  // A local file is signalled by a non-null `fromPath` and supersedes `versionRequest`.
  readonly versionRequest: string;
  readonly fromPath: string | null;
  readonly enableLinger: boolean;
  readonly allowSelfInvocation: boolean;
  // Install the host bytes only; leave OS-service registration to the host (mirrors `host ensure`'s flag) - the packaged-macOS pin path, where Desktop owns registration via SMAppService.
  // A null-runtime archive simply lands as `activationUnknown` debt.
  readonly noServiceRegister: boolean;
  // Hidden, internal - the CLI-owned pin gate.
  // After acquiring the lock (download/extract already done outside it), immediately before the service stop, probe `assertHostNotBusy`; busy -> `E_HOST_BUSY` with the extracted temp scrubbed.
  readonly ifIdle: boolean;
  // Install even when the host has work in progress: threaded into the service lifecycle so the pre-swap stop skips the cooperative shutdown claim and kills the host process, exactly like `host stop --force`.
  // Without it a busy host denies the claim and the install aborts with `E_HOST_BUSY` - which used to have no supported escape short of `host stop --force` + reinstall.
  readonly force: boolean;
  /** See `HostApplyArgs.attemptAdoption`. `null` for an ordinary invocation. */
  readonly attemptAdoption: string | null;
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

    // `--no-service-register` must be truly bytes-only: no stop, no register/rewrite, no start - even when a service is already registered.
    // `createServiceInstallLifecycle`'s `bootstrap: null` does not satisfy that (it still rewrites and re-loads an EXISTING registration post-swap), so this skips the service lifecycle entirely and uses the same bytes-only shape `host ensure` uses for `registerService: false`.
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

    const contenderOptions = {
      environment: ctx.runtime.environment,
      reason: "host-install",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "legacy-update-shadow" as const,
      adoption: await resolveAttemptAdoptionFromNonce(
        hostHomeDir(ctx.runtime.environment),
        args.attemptAdoption,
        Date.now(),
      ),
    };
    const result = await withCliUpdateExecutionSegment(
      contenderOptions,
      async (capability) => {
        const verify = (): Promise<void> =>
          requireCliUpdateMutationCapability(capability, contenderOptions);
        // The outer attempt capability intentionally spans staging.
        // This preserves the existing no-download-under-cli-lock rule while refusing active/corrupt attempt state before the first byte.
        const staged = await stageHostInstallSource({
          environment: ctx.runtime.environment,
          source,
          onProgress: (info) => ctx.progress(info),
          recordVersionOverride: null,
          verifyMutationCapability: verify,
        });
        try {
          return await withCliAttemptMutation(
            capability,
            contenderOptions,
            async () => {
              if (args.ifIdle) {
                await assertHostNotBusy(ctx.runtime.environment);
              }
              return commitHostInstallSourceWithAttempt(
                capability,
                contenderOptions,
                {
                  environment: ctx.runtime.environment,
                  staged,
                  onProgress: (info) => ctx.progress(info),
                  lifecycle,
                },
              );
            },
          );
        } catch (err) {
          // A failed final mutation leaves the pre-staged temp owned by this
          // execution segment. Scrub it before capability release.
          await discardStagedHostInstallSource(
            ctx.runtime.environment,
            staged,
            verify,
          );
          throw err;
        }
      },
    );

    ctx.runtime.logger.info("Host install command completed", {
      environment: ctx.runtime.environment,
      version: result.record.version,
      previousVersion: result.previous?.version ?? null,
      postSwapAction: handle !== null ? handle.state.postSwapAction : "none",
      hasPostSwapError: handle !== null && handle.state.postSwapError !== null,
    });

    // Post-install credential provisioning: leave the just-started host holding its own `aud: "host"` credential rather than waiting for the first minting client to happen to connect.
    // Only where it can help: - the service lifecycle actually started/restarted a host (`postSwapAction`), cleanly - a host that failed its post-swap start has nothing to dial; - the pre-flight left us signed in (the mint spends the bearer).
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
    // Restate the unauthenticated warning on the terminal line - the pre-flight's copy printed before a potentially long download and may have scrolled away.
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
