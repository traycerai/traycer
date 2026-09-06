import type { CommandFn, CommandResult } from "../runner/runner";
import {
  runHostUpdate,
  type HostUpdateRunOutcome,
  type LegacyHostUpdateResult,
} from "../host/update-run";

// `traycer host update [--version X] [--force]` - the THIN SHELL.
//
// Argument parsing, the `LegacyHostUpdateResult` projection and the human
// summary live here; the run itself is `host/update-run.ts`, which owns the
// advisory plan, the under-lock claim selection, the record writer, every arm
// and the dispatch ACK. This file must never import `host/update-executor.ts`
// directly - the admission fence in
// `host/__tests__/update-executor.test.ts` pins that the released command
// surface reaches the executor only through its dedicated owner.
//
// Legacy wire-contract compat: Desktop's `host-management-ipc.ts` runs `host
// update`'s stdout through `projectInstallResult`, which reads a FLAT legacy
// shape off `data` and silently degrades every field to a fallback ("", 0,
// "none") if the shape changes. Desktop no longer shells `host update` for its
// own updates - it runs `host download` and applies itself - so this boundary
// exists for `--json` consumers and the human summary alone. Remove only when
// that projection is deleted.
export interface HostUpdateArgs {
  /** Explicit installs may downgrade; automatic update callers never opt in. */
  readonly allowDowngrade: boolean;
  readonly force: boolean;
  /** `null` stages the latest registry version; an explicit value is a pin. */
  readonly versionRequest?: string | null;
  /**
   * Correlation nonce for the dispatch ACK. A nonce, never a token: it grants
   * nothing, so argv is a legitimate carrier. The child stamps it into the
   * sibling ACK file once its claim is durable (or once it has decided there
   * is no attempt to name), and the resolver accepts an ACK only when the
   * nonce matches one it minted for a child it spawned.
   */
  readonly ackNonce: string | null;
  /**
   * The bound intent, exactly as it arrived on argv (Plan D16). Raw all the
   * way through to `runHostUpdate`, which refuses an illegal value with a CLI
   * error a caller can read - and does so on the far side of its dispatch-ACK
   * stamper, so the refusal still reaches the dispatching host.
   */
  readonly intent: string | null;
  /** The attempt id a bound intent is bound to. */
  readonly expectAttempt: string | null;
}

export type {
  LegacyHostUpdateResult,
  LegacyHostUpdateServiceLifecycle,
} from "../host/update-run";

export function buildHostUpdateCommand(args: HostUpdateArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const environment = ctx.runtime.environment;
    ctx.runtime.logger.info("Host update command started", {
      environment,
      force: args.force,
    });
    const outcome = await runHostUpdate(
      {
        environment,
        logger: ctx.runtime.logger,
        onProgress: (info) => ctx.progress(info),
        versionRequest: args.versionRequest ?? null,
        allowDowngrade: args.allowDowngrade,
        force: args.force,
        ackNonce: args.ackNonce,
        // RAW. The pairing rule and the legal-value check live inside the run,
        // after its dispatch-ACK stamper exists: a run dispatched with a nonce
        // and an unusable intent pair must still answer the host that is
        // waiting on it, and a refusal thrown out here could not.
        intent: args.intent,
        expectAttempt: args.expectAttempt,
        registryClient: null,
        verifyBudgetMs: null,
        verifyPollIntervalMs: null,
      },
      process.env,
    );
    ctx.runtime.logger.info("Host update command completed", {
      environment,
      version: outcome.legacy.version,
      changed: outcome.legacy.previousVersion !== outcome.legacy.version,
      releasedReason: outcome.releasedReason,
      hasPostSwapError: outcome.legacy.serviceLifecycle.postSwapError !== null,
    });
    return {
      data: outcome.legacy,
      human: humanSummary(outcome),
      exitCode: 0,
    };
  };
}

function humanSummary(outcome: HostUpdateRunOutcome): string {
  const legacy = outcome.legacy;
  if (outcome.releasedReason !== null) {
    return outcome.releasedReason === "nothing-to-do"
      ? `host already at ${legacy.version} (no-op)`
      : `host update did not claim an attempt (${outcome.releasedReason}); host stays at ${legacy.version}`;
  }
  if (legacy.previousVersion === legacy.version) {
    return `host already at ${legacy.version} (no-op)`;
  }
  if (legacy.serviceLifecycle.postSwapError !== null) {
    return `updated host to ${legacy.version}; service did not converge: ${legacy.serviceLifecycle.postSwapError}`;
  }
  return `updated host ${legacy.previousVersion ?? "?"} → ${legacy.version}`;
}
