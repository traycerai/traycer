import { applyHost, type ApplyHostOutcome } from "../installer/apply";
import { downloadAndStageHost } from "../installer/download-stage";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import { readHostStagedRecord } from "../manifest/host-staged";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { ProgressInfo } from "../runner/output";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliLock } from "../store/cli-lock";

// `traycer host update [--force]` - the composite (Host Update Layer
// Redesign Tech Plan, "New/changed commands" > `host update`, D6): stage
// whatever `latest` requires (reusing an existing stage, explicit-
// incomparable policy - a `local-*` install proceeds), then promote it.
// `downloadAndStageHost` runs its OWN brief lock spans internally (no
// network transfer ever runs under `cli-lock` - plan rule 1); only the
// apply half below acquires the lock, matching `host apply`'s own
// contract that the caller holds it across reconcile/read/no-op/busy/
// commit.
//
// Busy (D6): the stage is kept - `applyHost`'s busy check runs before it
// touches the stage - and this command re-throws `E_HOST_BUSY` with the
// staged version attached to `details`, rather than the generic
// `details: null` `assertHostNotBusy` throws on its own.
//
// Legacy wire-contract compat: Desktop's `host-management-ipc.ts` runs
// `host update`'s stdout through `projectInstallResult`, which reads a
// *flat* legacy shape off `data` (`version`, `installedAt`,
// `executablePath`, `source`, `archiveSha256`, `signatureKeyId`,
// `sizeBytes`, `previousVersion`, `serviceLifecycle`) and silently
// degrades every field to a fallback ("", 0, "none") if the shape
// changes - Desktop bundles a version-matched CLI (D7), so "this CLI +
// Desktop's not-yet-rewired handler" is a real shipped pairing, not a
// hypothetical (D6's rejected-alternative note: "breaks the existing
// `HostInstallResult` projection mid-migration"). `host apply` is a
// brand-new command with no such consumer and is free to use
// `ApplyHostOutcome` directly (see `commands/host-apply.ts`); this
// compat boundary is scoped to `host update` alone - remove only when
// Desktop's `host update` invocation is deleted (post ticket-4 cleanup).
export interface HostUpdateArgs {
  readonly force: boolean;
}

export interface LegacyHostUpdateServiceLifecycle {
  readonly priorServiceState: "running" | "stopped" | "not-installed";
  readonly stoppedBeforeSwap: boolean;
  readonly postSwapAction: "restart" | "start" | "install" | "none";
  readonly postSwapError: string | null;
}

export interface LegacyHostUpdateResult {
  readonly version: string;
  readonly installedAt: string;
  readonly executablePath: string;
  readonly source: HostInstallRecord["source"];
  readonly archiveSha256: string | null;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
  readonly previousVersion: string | null;
  readonly serviceLifecycle: LegacyHostUpdateServiceLifecycle;
}

// Matches `projectInstallResult`'s own fallback when `serviceLifecycle`
// is absent from the payload - used whenever this command's own
// operation took no service action (a genuine no-op) rather than
// hand-rolling an equivalent-but-distinct literal.
const NO_SERVICE_ACTION_LIFECYCLE: LegacyHostUpdateServiceLifecycle = {
  priorServiceState: "not-installed",
  stoppedBeforeSwap: false,
  postSwapAction: "none",
  postSwapError: null,
};

export function buildHostUpdateCommand(args: HostUpdateArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host update command started", {
      environment: ctx.runtime.environment,
      force: args.force,
    });

    const downloadOutcome = await downloadAndStageHost({
      environment: ctx.runtime.environment,
      versionRequest: null,
      automatic: false,
      onProgress: (info) => ctx.progress(info),
      registryClient: null,
    });
    ctx.runtime.logger.info("Host update stage phase completed", {
      environment: ctx.runtime.environment,
      outcome: downloadOutcome.outcome,
    });

    // "Zero fetch beyond the manifest when at latest": already at (or
    // past) the target, so the apply half never needs to run - still
    // routed through the same locked projection below (not a bare
    // early return) so the legacy backfill read is never a racy
    // unlocked read.
    const needsApply = !(
      downloadOutcome.outcome === "short-circuit" &&
      downloadOutcome.reason === "installed-up-to-date"
    );

    const legacy = await applyAndProjectLegacy(
      ctx.runtime.environment,
      args.force,
      needsApply,
      (info) => ctx.progress(info),
    );

    ctx.runtime.logger.info("Host update command completed", {
      environment: ctx.runtime.environment,
      downloadOutcome: downloadOutcome.outcome,
      version: legacy.version,
      changed: legacy.previousVersion !== legacy.version,
      hasPostSwapError: legacy.serviceLifecycle.postSwapError !== null,
    });
    return {
      data: legacy,
      human: humanSummary(legacy),
      exitCode: 0,
    };
  };
}

async function applyAndProjectLegacy(
  environment: Environment,
  force: boolean,
  needsApply: boolean,
  onProgress: (info: ProgressInfo) => void,
): Promise<LegacyHostUpdateResult> {
  return withCliLock(
    {
      environment,
      reason: "host-update-apply",
      waitMs: 30_000,
      pollIntervalMs: 100,
    },
    async () => {
      if (!needsApply) {
        return projectNoOp(await requireInstalled(environment));
      }
      let outcome: ApplyHostOutcome;
      try {
        outcome = await applyHost({
          environment,
          force,
          noService: false,
          expectedStageFingerprint: null,
          onProgress,
        });
      } catch (err) {
        if (err instanceof CliError && err.code === CLI_ERROR_CODES.HOST_BUSY) {
          // The stage was left intact by `applyHost`'s own busy check (it
          // runs before any commit) - read it HERE, still inside the same
          // lock span `applyHost`'s busy decision was made under (never
          // re-acquired), so the reported version can't have changed out
          // from under the decision the way a read after this call's own
          // lock release could. D6's "staged-version details in the error
          // payload" contract needs this coherence, not just a value.
          const staged = await readHostStagedRecord(environment);
          throw cliError({
            code: CLI_ERROR_CODES.HOST_BUSY,
            message: err.message,
            details: { stagedVersion: staged?.version ?? null },
            exitCode: err.exitCode,
          });
        }
        throw err;
      }
      if (outcome.outcome === "no-op") {
        // Still holding the same lock `applyHost` itself ran under
        // (it assumes the caller holds `cli-lock`, never re-acquires)
        // - this re-read observes exactly the state `applyHost` had
        // internal access to but didn't return, not a fresh race.
        return projectNoOp(await requireInstalled(environment));
      }
      if (outcome.outcome === "stage-fingerprint-mismatch") {
        throw cliError({
          code: CLI_ERROR_CODES.UNEXPECTED,
          message: "host update: staged handoff changed unexpectedly",
          details: {
            expectedStageFingerprint: outcome.expectedStageFingerprint,
            actualStageFingerprint: outcome.actualStageFingerprint,
          },
          exitCode: 1,
        });
      }
      return projectApplied(outcome);
    },
  );
}

async function requireInstalled(
  environment: Environment,
): Promise<HostInstallRecord> {
  const installed = await readHostInstallRecord(environment);
  if (installed === null) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_NOT_INSTALLED,
      message: `host update: no host installed for environment=${environment}; run 'traycer host install latest' first`,
      details: { environment },
      exitCode: 1,
    });
  }
  return installed;
}

function projectNoOp(installed: HostInstallRecord): LegacyHostUpdateResult {
  return {
    version: installed.version,
    installedAt: installed.installedAt,
    executablePath: installed.executablePath,
    source: installed.source,
    archiveSha256: installed.archiveSha256,
    signatureKeyId: installed.signatureKeyId,
    sizeBytes: installed.sizeBytes,
    previousVersion: installed.version,
    serviceLifecycle: NO_SERVICE_ACTION_LIFECYCLE,
  };
}

function projectApplied(
  outcome: Extract<ApplyHostOutcome, { outcome: "applied" }>,
): LegacyHostUpdateResult {
  return {
    version: outcome.record.version,
    installedAt: outcome.record.installedAt,
    executablePath: outcome.record.executablePath,
    source: outcome.record.source,
    archiveSha256: outcome.record.archiveSha256,
    signatureKeyId: outcome.record.signatureKeyId,
    sizeBytes: outcome.record.sizeBytes,
    previousVersion: outcome.previous?.version ?? null,
    serviceLifecycle:
      outcome.serviceLifecycle === null
        ? NO_SERVICE_ACTION_LIFECYCLE
        : {
            ...outcome.serviceLifecycle,
            priorServiceState: toLegacyPriorServiceState(
              outcome.serviceLifecycle.priorServiceState,
            ),
            postSwapError: outcome.postSwapError,
          },
  };
}

// `LegacyHostUpdateServiceLifecycle` is a pinned, frozen wire shape (see
// the module doc comment) - it must not silently grow to track new
// `ServiceState` variants. `externally-managed` (macOS SMAppService-owned
// label, added after this shape was pinned) has no legacy equivalent;
// degrade it to `not-installed` exactly as Desktop's own
// `projectInstallResult` reader already degrades any `priorServiceState`
// value outside its own three-way union, so the projected wire value
// matches what an old-CLI payload would already read as.
function toLegacyPriorServiceState(
  state: "running" | "stopped" | "not-installed" | "externally-managed",
): "running" | "stopped" | "not-installed" {
  return state === "externally-managed" ? "not-installed" : state;
}

function humanSummary(legacy: LegacyHostUpdateResult): string {
  if (legacy.previousVersion === legacy.version) {
    return `host already at ${legacy.version} (no-op)`;
  }
  if (legacy.serviceLifecycle.postSwapError !== null) {
    return `updated host to ${legacy.version}; service did not converge: ${legacy.serviceLifecycle.postSwapError}`;
  }
  return `updated host ${legacy.previousVersion ?? "?"} → ${legacy.version}`;
}
