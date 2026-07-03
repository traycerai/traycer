import {
  installHost,
  rollbackToVersionedDir,
  type InstallHostResult,
} from "../installer";
import { assertHostNotBusy } from "../host/busy-check";
import { readHostInstallRecord } from "../manifest/host-install";
import {
  deleteUpdateProgressMarker,
  writeUpdateProgressMarker,
} from "../host/update-progress-marker";
import { probeHostHealth } from "../service/health-probe";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { formatServiceLifecycleWarning } from "../service";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";

// `traycer host update --version <v> [--force]` - the command the host
// daemon spawns DETACHED (fire-and-forget, not waited on) once it decides
// - via its own drain predicate - that the host is idle, or the user
// explicitly forced an update past busy sessions. Because the daemon does
// not wait for this process, and because its "idle" decision may be stale
// by the time this process actually runs, this command re-verifies busy
// state itself (`assertHostNotBusy`, skipped only when THIS invocation's
// own `--force` is set) - the daemon's earlier decision is never trusted
// as the sole gate. That is the "never kills silently" guarantee: two
// independent busy checks, either of which can block the swap, and only an
// explicit `--force` on the invocation that's actually about to touch
// bytes bypasses one of them.
//
// End-to-end flow:
//   1. Re-verify busy state (unless --force).
//   2. Write the update-progress marker (state: "updating") BEFORE
//      touching anything - the daemon's cross-process handoff contract.
//   3. Run installHost (stage -> verify -> extract -> stop service ->
//      atomic swap -> write record -> restart service), same as today.
//   4. Run a bounded, purely-local health probe (service/health-probe.ts)
//      against the just-restarted process - pid liveness + a loopback TCP
//      dial. This probe makes ZERO calls to the coordination server: a CS
//      blip must never look like "the new binary is broken".
//   5. On probe success: delete the marker (clean success - the daemon's
//      next heartbeat derives `current` from the new `appVersion`).
//   6. On probe failure: roll back to the previous versioned dir (if any),
//      cycle the service again so it comes back up on the reverted
//      binary, rewrite the marker as `failed`, and surface the failure via
//      a thrown CliError.
export interface HostUpdateArgs {
  // Target registry version. The daemon always passes an explicit value;
  // interactive/manual use defaults to "latest" when omitted (see
  // src/index.ts's `--version` wiring).
  readonly version: string;
  // Skip the busy check and update a running host unconditionally.
  // Surfaced as `--force`, matching `host ensure`'s flag. Does NOT skip
  // the post-swap health probe / rollback - those are independent of how
  // the swap was authorized.
  readonly force: boolean;
}

export function buildHostUpdateCommand(args: HostUpdateArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const environment = ctx.runtime.environment;
    ctx.runtime.logger.info("Host update command started", {
      environment,
      force: args.force,
      versionRequest: args.version,
    });
    return withCliLock(
      {
        environment,
        reason: "host-update",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        const previous = await readHostInstallRecord(environment);
        if (previous === null) {
          ctx.runtime.logger.warn(
            "Host update refused because host is not installed",
            { environment },
          );
          throw cliError({
            code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
            message: `host update: no host installed for environment=${environment}; run 'traycer host install latest' first`,
            details: { environment },
            exitCode: 1,
          });
        }

        // Independent re-verification of busy state for THIS invocation -
        // see the module doc comment above. `assertHostNotBusy` is the
        // same fail-safe probe `host install`/`host ensure` already use;
        // only this invocation's own `--force` skips it.
        if (!args.force) {
          await assertHostNotBusy(environment);
        } else {
          ctx.runtime.logger.warn(
            "Host update skipped busy guard because force=true",
            { environment },
          );
        }

        await writeUpdateProgressMarker(environment, {
          state: "updating",
          error: null,
          targetVersion: args.version,
          updatedAt: new Date().toISOString(),
        });

        // `host update` assumes the service is already registered; if it
        // isn't, leave registration to the operator (`traycer host service
        // install`) rather than silently bootstrapping on an update path.
        const handle = createServiceInstallLifecycle({
          environment,
          bootstrap: null,
        });
        ctx.runtime.logger.debug("Host update lifecycle created", {
          environment,
          previousVersion: previous.version,
        });

        let result: InstallHostResult;
        try {
          result = await installHost({
            environment,
            source: { kind: "registry", versionRequest: args.version },
            onProgress: (info) => ctx.progress(info),
            lifecycle: handle.lifecycle,
            // Registry update records the registry version; nothing to
            // override.
            recordVersionOverride: null,
          });
        } catch (cause) {
          // Stage/verify/extract/swap failed before ever reaching a
          // health-checkable state - `installHost`'s own verify-before-
          // replace contract means the OLD host is untouched, so there is
          // nothing to roll back. Still terminate the "updating" marker so
          // the daemon doesn't see it stuck forever.
          await writeUpdateProgressMarker(environment, {
            state: "failed",
            error: shortErrorDetail(cause),
            targetVersion: args.version,
            updatedAt: new Date().toISOString(),
          });
          ctx.runtime.logger.error(
            "Host update install failed before health probe",
            { environment, targetVersion: args.version },
            cause instanceof Error ? cause : null,
          );
          throw cause;
        }

        const probe = await probeHostHealth({
          environment,
          checkProcessAlive: null,
          checkTcpReachable: null,
          totalBudgetMs: null,
          retryDelayMs: null,
        });

        const lifecycleData = {
          priorServiceState: handle.state.priorState,
          stoppedBeforeSwap: handle.state.stoppedBeforeSwap,
          postSwapAction: handle.state.postSwapAction,
          postSwapError: handle.state.postSwapError,
        };

        if (probe.healthy) {
          await deleteUpdateProgressMarker(environment);
          const baseHuman =
            previous.version === result.record.version
              ? `host already at ${result.record.version} (no-op; health check passed)`
              : `updated host ${previous.version} -> ${result.record.version} (health check passed)`;
          ctx.runtime.logger.info("Host update command completed", {
            environment,
            previousVersion: previous.version,
            version: result.record.version,
            changed: previous.version !== result.record.version,
            postSwapAction: handle.state.postSwapAction,
            hasPostSwapError: handle.state.postSwapError !== null,
            healthy: true,
          });
          return {
            data: {
              version: result.record.version,
              previousVersion: previous.version,
              installedAt: result.record.installedAt,
              source: result.record.source,
              serviceLifecycle: lifecycleData,
              healthCheck: { healthy: true, detail: probe.detail },
            },
            human:
              handle.state.postSwapError !== null
                ? `${baseHuman}; ${formatServiceLifecycleWarning(handle.state.postSwapAction, handle.state.postSwapError)}`
                : baseHuman,
            exitCode: 0,
          };
        }

        // Health probe exhausted its budget - roll back.
        ctx.runtime.logger.error(
          "Host update health probe failed; rolling back",
          {
            environment,
            targetVersion: args.version,
            newVersion: result.record.version,
            previousVersion: previous.version,
            hasPreviousVersionedDir: result.previousVersionedDir !== null,
            probeDetail: probe.detail,
          },
          null,
        );
        if (result.previousVersionedDir !== null) {
          await rollbackToVersionedDir(
            environment,
            result.previousVersionedDir,
          );
          const rollbackLifecycle = createServiceInstallLifecycle({
            environment,
            bootstrap: null,
          });
          // Cycle the service again so it stops the failed new process and
          // comes back up on the now-reverted-to-old binary. Mirrors the
          // same beforeSwap/afterSwap pair `installHost` runs around a
          // forward swap.
          await rollbackLifecycle.lifecycle.beforeSwap();
          await rollbackLifecycle.lifecycle.afterSwap();
        }

        await writeUpdateProgressMarker(environment, {
          state: "failed",
          error: probe.detail,
          targetVersion: args.version,
          updatedAt: new Date().toISOString(),
        });

        throw cliError({
          code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
          message:
            result.previousVersionedDir !== null
              ? `host update: new host ${result.record.version} failed its post-update health check and was rolled back to ${previous.version}: ${probe.detail}`
              : `host update: new host ${result.record.version} failed its post-update health check (no previous version to roll back to): ${probe.detail}`,
          details: {
            targetVersion: args.version,
            attemptedVersion: result.record.version,
            previousVersion: previous.version,
            rolledBack: result.previousVersionedDir !== null,
            probeDetail: probe.detail,
          },
          exitCode: 1,
        });
      },
    );
  };
}

function shortErrorDetail(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const MAX_LENGTH = 500;
  return message.length > MAX_LENGTH
    ? `${message.slice(0, MAX_LENGTH)}...`
    : message;
}
