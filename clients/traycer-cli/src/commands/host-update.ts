import { installHost } from "../installer";
import {
  compareHostVersions,
  isHostSemanticVersion,
} from "@traycer-clients/shared/platform/runner-host";
import { assertHostNotBusy } from "../host/busy-check";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { formatServiceLifecycleWarning } from "../service";
import { createServiceInstallLifecycle } from "../service/install-lifecycle";
import { withCliLock } from "../store/cli-lock";

// `traycer host update` - convenience over `host install latest`
// that surfaces an explicit error when no host is installed yet
// (Tech Plan: discovery via CLI is explicit, no ambient updates).
//
// Uses the same stop-before-swap / start-after-swap lifecycle as
// `host install` so an in-place update doesn't leave the OS service
// pointed at a half-replaced install dir (especially relevant on
// Windows where executable locks block the rename otherwise).
export interface HostUpdateArgs {
  // Exact registry version selected by Desktop when prereleases are enabled;
  // "latest" preserves the stable manifest pointer for normal CLI usage.
  readonly versionRequest: string;
  // Skip the busy check and update a running host unconditionally.
  // Surfaced as `--force`, matching `host ensure`'s flag.
  readonly force: boolean;
}

export function buildHostUpdateCommand(args: HostUpdateArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host update command started", {
      environment: ctx.runtime.environment,
      versionRequest: args.versionRequest,
      force: args.force,
    });
    return withCliLock(
      {
        environment: ctx.runtime.environment,
        reason: "host-update",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      async () => {
        const { readHostInstallRecord } =
          await import("../manifest/host-install");
        const previous = await readHostInstallRecord(ctx.runtime.environment);
        if (previous === null) {
          ctx.runtime.logger.warn(
            "Host update refused because host is not installed",
            {
              environment: ctx.runtime.environment,
            },
          );
          throw cliError({
            code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
            message: `host update: no host installed for environment=${ctx.runtime.environment}; run 'traycer host install latest' first`,
            details: { environment: ctx.runtime.environment },
            exitCode: 1,
          });
        }
        if (
          args.versionRequest !== "latest" &&
          isHostSemanticVersion(args.versionRequest) &&
          isHostSemanticVersion(previous.version)
        ) {
          const targetComparison = compareHostVersions(
            args.versionRequest,
            previous.version,
          );
          if (targetComparison < 0) {
            throw cliError({
              code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
              message: `host update: refusing to downgrade ${previous.version} to ${args.versionRequest}; use 'traycer host install --release ${args.versionRequest}' for a deliberate operator downgrade`,
              details: {
                installedVersion: previous.version,
                requestedVersion: args.versionRequest,
              },
              exitCode: 1,
            });
          }
          if (targetComparison === 0) {
            return {
              data: {
                version: previous.version,
                previousVersion: previous.version,
                installedAt: previous.installedAt,
                source: previous.source,
              },
              human: `host already at ${previous.version} (no-op)`,
              exitCode: 0,
            };
          }
        }
        // Every update replaces the bytes of a potentially-LIVE host, same
        // hazard `provisionHost` guards against - refuse unless the host is
        // confirmed idle (or unreachable), fail-safe otherwise. `--force`
        // (matching `host ensure`) skips this for the desktop's "Force
        // update" path.
        if (!args.force) {
          await assertHostNotBusy(ctx.runtime.environment);
        } else {
          ctx.runtime.logger.warn(
            "Host update skipped busy guard because force=true",
            {
              environment: ctx.runtime.environment,
            },
          );
        }
        // `host update` assumes the service is already registered; if it
        // isn't, leave registration to the operator (`traycer host service
        // install`) rather than silently bootstrapping on an update path.
        const handle = createServiceInstallLifecycle({
          environment: ctx.runtime.environment,
          bootstrap: null,
        });
        ctx.runtime.logger.debug("Host update lifecycle created", {
          environment: ctx.runtime.environment,
          previousVersion: previous.version,
        });
        const result = await installHost({
          environment: ctx.runtime.environment,
          source: { kind: "registry", versionRequest: args.versionRequest },
          onProgress: (info) => ctx.progress(info),
          lifecycle: handle.lifecycle,
          // Registry update records the registry version; nothing to override.
          recordVersionOverride: null,
        });
        const lifecycleData = {
          priorServiceState: handle.state.priorState,
          stoppedBeforeSwap: handle.state.stoppedBeforeSwap,
          postSwapAction: handle.state.postSwapAction,
          postSwapError: handle.state.postSwapError,
        };
        const baseHuman =
          previous.version === result.record.version
            ? `host already at ${result.record.version} (no-op)`
            : `updated host ${previous.version} → ${result.record.version}`;
        ctx.runtime.logger.info("Host update command completed", {
          environment: ctx.runtime.environment,
          previousVersion: previous.version,
          version: result.record.version,
          changed: previous.version !== result.record.version,
          postSwapAction: handle.state.postSwapAction,
          hasPostSwapError: handle.state.postSwapError !== null,
        });
        return {
          data: {
            version: result.record.version,
            previousVersion: previous.version,
            installedAt: result.record.installedAt,
            source: result.record.source,
            serviceLifecycle: lifecycleData,
          },
          human:
            handle.state.postSwapError !== null
              ? `${baseHuman}; ${formatServiceLifecycleWarning(handle.state.postSwapAction, handle.state.postSwapError)}`
              : baseHuman,
          exitCode: 0,
        };
      },
    );
  };
}
