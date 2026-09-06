import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import {
  runHostUpdate,
  type HostUpdateBoundIntent,
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
   * The bound intent, exactly as it arrived on argv (Plan D16). Raw rather
   * than pre-narrowed so an illegal value is refused HERE, with a CLI error a
   * caller can read, instead of being silently widened at the registration
   * site.
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
    const intent = parseBoundIntent(args.intent, args.expectAttempt);
    const outcome = await runHostUpdate(
      {
        environment,
        logger: ctx.runtime.logger,
        onProgress: (info) => ctx.progress(info),
        versionRequest: args.versionRequest ?? null,
        allowDowngrade: args.allowDowngrade,
        force: args.force,
        ackNonce: args.ackNonce,
        intent,
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

/**
 * The `--intent` / `--expect-attempt` pairing, refused in the command body.
 *
 * Commander has no option pairing: its parser rejects UNKNOWN options (which
 * is the whole point of putting the intent on argv - a pre-cutover parser
 * exits before any body runs) but it has nothing to say about two options that
 * are only meaningful together. A bound intent with no attempt to bind to is
 * an authorization with no subject, and running it as a plain install would be
 * exactly the broader authorization the argv contract exists to prevent.
 */
function parseBoundIntent(
  intent: string | null,
  expectAttempt: string | null,
): HostUpdateBoundIntent | null {
  if (intent !== null && intent !== "activate" && intent !== "continue") {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `host update: --intent must be 'activate' or 'continue' (got '${intent}')`,
      details: { intent },
      exitCode: 1,
    });
  }
  if (intent === null && expectAttempt !== null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "host update: --expect-attempt names the attempt a bound intent acts on; pass --intent too",
      details: { expectAttempt },
      exitCode: 1,
    });
  }
  if (intent !== null && expectAttempt === null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `host update: --intent ${intent} needs the attempt it is bound to; pass --expect-attempt <id>`,
      details: { intent },
      exitCode: 1,
    });
  }
  return intent;
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
