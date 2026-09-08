import type { ApplyHostOutcome } from "../installer/apply";
import { NO_INSTALL_PHASE_HOOKS } from "../installer/install";
import { withCliUpdateContender } from "../host/update-contender";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import { resolveAttemptAdoptionFromNonce } from "../host/update-adoption";
import { hostHomeDir } from "../store/paths";
import { applyHostWithAttempt } from "../host/update-mutation";
import { readHostHeldVersion } from "@traycer/protocol/config/installation";
import { readHostInstallRecord } from "../manifest/host-install";
import { createRegistryYankLookup } from "../registry/client";
import type { CommandFn, CommandResult } from "../runner/runner";

// `traycer host apply [--force] [--no-service]` - promotes the single-slot
// staged tree over the current install (Host Update Layer Redesign Tech
// Plan, "New/changed commands" > `host apply`). The entire reconcile ->
// read-records -> no-op/busy-check -> commit flow runs inside ONE
// `cli-lock` acquisition - see `installer/apply.ts`'s `applyHost`, which
// assumes it is already running under the lock, same contract as
// `installHost`.
//
// `--no-service` is internal/hidden (the desktop-owned packaged-macOS
// path, which drives its own locked SMAppService activation cycle after a
// non-disruptive bytes-only apply) - see the registration site in
// `index.ts`.
//
// SUCCESS CONTRACT, and why it deliberately differs from `host update`'s.
// Exit 0 here means THE SWAP COMMITTED - not that the host came back. A
// post-swap service start that fails is reported as `postSwapError` on an
// `applied` outcome, per `applyHost`'s explicit no-rollback contract, and
// `runningActivated` says whether a start was REQUESTED and accepted - not
// that anything is serving. See `activationOf`.
//
// That is not an accident to be aligned away. `host apply` is the low-level
// primitive whose committed/not-committed answer callers need SEPARATELY from
// convergence: Desktop's `applyStagedCliOwned` reads `postSwapError` off this
// exit-0 envelope and renders "installed, not converged" with a Doctor
// pointer, and it reserves the thrown-error path for applies that did not
// commit at all (where its recovery is "retry with force"). Exiting non-zero
// on a failed post-swap start would route a committed swap into that
// wrong-recovery branch.
//
// `host update` is the composite and answers the other question - it stages,
// applies, then health-probes, and FAILS (`E_HOST_UPDATE_HEALTH_CHECK_FAILED`)
// when the updated host does not come back. A caller that wants "the host is
// running the new version or tell me it isn't" wants `host update`; a caller
// that wants "commit these bytes and report what happened" wants this. Both
// commands state that in their help; `activation` below makes the distinction
// readable from the payload without re-deriving it from three fields - and is
// carefully NOT called "converged", because nothing here probes health.
export interface HostApplyArgs {
  readonly force: boolean;
  readonly noService: boolean;
  readonly expectedStageFingerprint: string | null;
  /**
   * IMPLICIT apply: honour the version hold. When true, this command re-reads
   * the installed and held records UNDER its own CLI mutation lock and no-ops
   * instead of applying when the installed host IS the deliberately-held
   * instance (`installId` match) and is still viable - a held host the
   * registry has yanked voids its hold and is applied over (fail-open: an
   * unreachable registry keeps the hold). This is the ONLY place the hold is
   * decided: the desktop's launch-time (implicit) apply always passes it and
   * never pre-judges the hold from its own snapshot, because a terminal
   * downgrade can commit between any sample it takes and this lock - a
   * snapshot that suppressed the call would let that race revert a fresh
   * downgrade, or park a withdrawn one. An explicit "Update now" apply leaves this false and always
   * applies; it needs no hold write, since moving forward installs a new
   * instance whose id no longer matches the held one.
   */
  readonly respectHold: boolean;
  /**
   * Nonce naming a parent executor's live-lock proof, when this invocation was
   * spawned from inside a held segment. `null` for every ordinary invocation,
   * which keeps the acquire-or-refuse path exactly as it was.
   */
  readonly attemptAdoption: string | null;
}

export function buildHostApplyCommand(args: HostApplyArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host apply command started", {
      environment: ctx.runtime.environment,
      force: args.force,
      noService: args.noService,
    });
    const adoption = await resolveAttemptAdoptionFromNonce(
      hostHomeDir(ctx.runtime.environment),
      args.attemptAdoption,
      Date.now(),
    );
    // ONE options value for acquisition and revalidation: two literals that
    // must stay identical are how admission policies drift.
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment: ctx.runtime.environment,
      reason: "host-apply",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "legacy-update-shadow",
      adoption,
    };
    const outcome = await withCliUpdateContender(
      contenderOptions,
      async (capability) => {
        // Finding 3: the authoritative hold check for an IMPLICIT apply, made
        // HERE under the CLI mutation lock rather than trusting the desktop's
        // earlier preflight. A terminal downgrade that set the hold while the
        // launch apply was still staging is serialized behind this same lock,
        // so by the time we read the install record it reflects that downgrade
        // - and we no-op instead of reverting it. An explicit apply
        // (`respectHold: false`) skips this and always applies.
        if (args.respectHold) {
          const held = await readHostHeldVersion(ctx.runtime.environment);
          if (held !== null) {
            const installed = await readHostInstallRecord(
              ctx.runtime.environment,
            );
            // Match on the install INSTANCE (`installId`), not the version, so
            // a later reinstall of the same version is never mistaken for the
            // held one.
            if (installed !== null && installed.installId === held.installId) {
              // A hold protects a deliberate choice from client PREFERENCE,
              // never from curation: a held host the registry has since YANKED
              // is not viable, so the hold is void and the apply proceeds. The
              // lookup fails open (offline / malformed / timed out reads as
              // not yanked), the same bias as `viability`'s yank check - a
              // network blip keeps the hold rather than reverting it.
              const yanked = await createRegistryYankLookup(
                ctx.runtime.environment,
              ).isVersionYanked(installed.version);
              if (!yanked) {
                ctx.runtime.logger.info(
                  "Host apply skipped: installed host is the held one",
                  {
                    environment: ctx.runtime.environment,
                    version: held.version,
                  },
                );
                return {
                  outcome: "no-op" as const,
                  installedVersion: installed.version,
                };
              }
              ctx.runtime.logger.warn(
                "Host apply overriding the version hold: the held host is yanked",
                { environment: ctx.runtime.environment, version: held.version },
              );
            }
          }
        }
        // No version-hold WRITE follows a committed apply: an apply is always
        // a FORWARD move (the stage is only ever newer than the install),
        // which the hold model treats as inert via the consulting gate
        // (`held !== installed`) rather than by deleting the record - so there
        // is nothing to clear and no clear/ABA race. The `respectHold` guard
        // above is this command's only hold interaction.
        return applyHostWithAttempt(capability, contenderOptions, {
          environment: ctx.runtime.environment,
          force: args.force,
          noService: args.noService,
          expectedStageFingerprint: args.expectedStageFingerprint,
          expectedStagedVersion: null,
          onProgress: (info) => ctx.progress(info),
          onWillCommitStaged: null,
          onWillDisruptHost: null,
          // `host apply` advances no attempt record of its own: Desktop
          // drives its own lane around this call and reads the outcome.
          hooks: NO_INSTALL_PHASE_HOOKS,
        });
      },
    );
    const activation = activationOf(outcome);
    ctx.runtime.logger.info("Host apply command completed", {
      environment: ctx.runtime.environment,
      outcome: outcome.outcome,
      activation,
    });
    return {
      // Additive sibling on the existing payload: every field callers already
      // read is untouched, and `activation` collapses the three fields that
      // answer "what happened to the service after the swap?" into one - the
      // question exit 0 does NOT answer here. See the success-contract note
      // above, and `activationOf` for why it is not called "converged".
      data: { ...outcome, activation },
      human: humanSummary(outcome),
      exitCode: 0,
    };
  };
}

/**
 * What happened to the SERVICE after the bytes committed - deliberately not
 * "is the host healthy?", which this command never asks.
 *
 * Naming this `converged` would have been the overclaim. `runningActivated`
 * means the post-swap start/restart returned without throwing, and on macOS
 * `launchctl kickstart` returns as soon as launchd ACCEPTS the request - a job
 * that is registered but unspawnable answers success (the same "requested, not
 * started" caveat `service/index.ts` records for `agentStartRequested`). So
 * the strongest honest value here is "requested".
 *
 *   - `requested`      the post-swap start/restart was accepted. NOT proof the
 *                      host is serving; `traycer host update` health-probes,
 *                      and `traycer host status` answers it directly.
 *   - `failed`         the post-swap start/restart REQUEST threw
 *                      (`postSwapError`). Bytes are committed; whether
 *                      anything is still serving was not checked.
 *   - `not-attempted`  committed, but no start ran - `--no-service` (no
 *                      lifecycle at all), or a `postSwapAction` of "none",
 *                      which is what a non-bootstrap caller gets against an
 *                      unregistered service. NOT the Desktop-managed macOS
 *                      case: that branch kickstarts the agent label and
 *                      reports "start".
 *   - `null`           nothing was committed (`no-op`,
 *                      `stage-fingerprint-mismatch`,
 *                      `stage-version-mismatch`), so there is no
 *                      activation to report. NOT `failed`: those outcomes
 *                      never touch or probe the running host, and reporting a
 *                      failure for a healthy, already-current install would be
 *                      a claim this command never made.
 */
type ApplyActivation = "requested" | "failed" | "not-attempted" | null;

function activationOf(outcome: ApplyHostOutcome): ApplyActivation {
  if (outcome.outcome !== "applied") return null;
  if (outcome.postSwapError !== null) return "failed";
  return outcome.runningActivated ? "requested" : "not-attempted";
}

function humanSummary(outcome: ApplyHostOutcome): string {
  if (outcome.outcome === "no-op") {
    return `host already at ${outcome.installedVersion} (no-op)`;
  }
  if (outcome.outcome === "stage-fingerprint-mismatch") {
    return "staged host changed after eligibility; retry against the current stage";
  }
  if (outcome.outcome === "stage-version-mismatch") {
    // Unreachable from this command (it pins no version), kept exhaustive
    // so a caller that starts pinning one gets a sentence, not a crash.
    return `staged host is ${outcome.actualStagedVersion}, not the requested ${outcome.expectedStagedVersion}; retry against the current stage`;
  }
  // These lines report the ACTIVATION, never liveness - the same distinction
  // `activation` draws in the payload, and for the same reason: nothing here
  // probes health. Saying "the host is NOT running" was the prose making the
  // claim the field had just stopped making, and it can be flatly wrong - a
  // bytes-only swap under a host nobody managed to stop leaves that host
  // serving the old bytes, alive, while the start never ran.
  if (outcome.postSwapError !== null) {
    return `applied host ${outcome.record.version}, but the post-swap start/restart request failed: ${outcome.postSwapError} - liveness was not checked; run 'traycer host status' to see what is running, then 'traycer host doctor'`;
  }
  if (!outcome.runningActivated) {
    return `applied host ${outcome.record.version}, but no start was run, so the new bytes are not active yet - run 'traycer host status' to see what is running`;
  }
  return `applied host ${outcome.record.version} (previous: ${outcome.previous?.version ?? "none"})`;
}
