import { hostname } from "node:os";
import { createInterface, type Interface } from "node:readline/promises";
import {
  mintHostCredentialViaHttp,
  requestStepUpChallengeViaHttp,
  verifyStepUpChallengeViaHttp,
} from "../../../shared/auth/devices-sessions-fetcher";
import type {
  HostCredentialMintFlow,
  HostCredentialMintOutcome,
} from "../../../shared/host-transport/host-credential-mint-flow";
import type { MintHostCredentialResponse } from "@traycer/protocol/auth/devices-sessions";

/**
 * How many mistyped codes are tolerated before the flow gives up. A typo must
 * not cost the whole grant, but an unbounded loop would block a long-running
 * command forever on a user who has walked away.
 */
const MAX_CODE_ATTEMPTS = 3;

/** Bounds a prompt nobody is answering, so a wedged terminal can't hang. */
const PROMPT_TIMEOUT_MS = 120_000;

const CODE_PATTERN = /^\d{6}$/;

export interface CliHostCredentialMintOptions {
  readonly authnBaseUrl: string;
  /** The CLI's current bearer; read at mint time so a rotation is picked up. */
  readonly bearer: () => string | null;
  /**
   * Whether a human can actually answer a prompt on this terminal. When false
   * the flow declines instead of blocking - `traycer monitor` normally runs as
   * a background command inside a TUI session, where a prompt would be written
   * to a stream nobody reads and the process would wait forever on stdin.
   */
  readonly interactive: boolean;
  /** Diagnostic sink; the CLI routes these to stderr, never stdout. */
  readonly diag: (message: string) => void;
}

/**
 * Terminal implementation of the delegated host-credential mint.
 *
 * The mint is always step-up gated, so the first request is expected to come
 * back `step-up-required`; that is the trigger for the email-OTP round trip,
 * not an error. Unlike desktop - where the verified step-up bearer is retained
 * in the main process and never shown to the renderer - the CLI is a single
 * process, so it holds the short-lived step-up token in memory only for the
 * immediate re-mint and never persists it.
 */
export function createCliHostCredentialMintFlow(
  options: CliHostCredentialMintOptions,
): HostCredentialMintFlow {
  return async (request): Promise<HostCredentialMintOutcome> => {
    // Checked BEFORE any request, not after the first one comes back
    // `step-up-required`. Two reasons, and the first is the serious one:
    // a bearer that happens to still be step-up-fresh would make that first
    // call SUCCEED, silently granting a machine 30 days of background
    // authority from a headless background command with no human present -
    // exactly the consent this flow exists to obtain. (It also stops a
    // headless loop from burning the per-IP mint budget, which the server
    // charges before it checks freshness.)
    if (!options.interactive) {
      options.diag(
        `host ${request.hostId} has no credential of its own; run \`traycer monitor\` from an interactive terminal to authorize one. Continuing without it — the host will stop working when this connection ends.`,
      );
      return { kind: "declined" };
    }

    const bearer = options.bearer();
    if (bearer === null || bearer.length === 0) {
      return { kind: "unavailable" };
    }

    const first = await mintHostCredentialViaHttp(
      options.authnBaseUrl,
      bearer,
      { hostId: request.hostId, hostLabel: hostLabel(), platform: null },
    );
    if (first.kind === "ok") {
      return provisionedFrom(first.response);
    }
    if (first.kind !== "step-up-required") {
      // Includes the 409 supersede: another client already provisioned this
      // host and its credential is on the way, so there is nothing to hand over
      // and nothing to retry.
      return { kind: "unavailable" };
    }

    const stepUpToken = await verifyStepUpInteractively(options);
    if (stepUpToken === null) {
      return { kind: "declined" };
    }

    const second = await mintHostCredentialViaHttp(
      options.authnBaseUrl,
      stepUpToken,
      { hostId: request.hostId, hostLabel: hostLabel(), platform: null },
    );
    if (second.kind === "ok") {
      return provisionedFrom(second.response);
    }
    options.diag(
      `could not authorize this host (${second.kind}); continuing without a host credential.`,
    );
    return { kind: "unavailable" };
  };
}

/**
 * Emails a code and reads it back from the terminal. Returns the verified
 * step-up bearer, or `null` when the user declined, ran out of attempts, or the
 * challenge could not be sent - all of which are "carry on without a host
 * credential", not failures.
 */
async function verifyStepUpInteractively(
  options: CliHostCredentialMintOptions,
): Promise<string | null> {
  const bearer = options.bearer();
  if (bearer === null || bearer.length === 0) {
    return null;
  }
  const challenge = await requestStepUpChallengeViaHttp(
    options.authnBaseUrl,
    bearer,
  );
  if (challenge.kind !== "ok") {
    options.diag(
      `could not send a verification code (${challenge.kind}); continuing without a host credential.`,
    );
    return null;
  }

  // Prompt on stderr: stdout is the agent-facing stream for `traycer monitor`
  // and must stay free of anything but inbox messages.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      "\nAuthorize this machine to keep running your work after you disconnect.\n" +
        "A 6-digit code was emailed to you. Press Enter on an empty line to skip.\n",
    );
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
      const answer = await promptWithinBudget(rl, "Email code: ");
      if (answer === null) {
        return null;
      }
      const code = answer.trim();
      if (code.length === 0) {
        return null;
      }
      if (!CODE_PATTERN.test(code)) {
        process.stderr.write("Enter the 6-digit code from your email.\n");
        continue;
      }
      // Re-read the bearer each round: a long pause at the prompt can outlive
      // the token the challenge was requested with.
      const current = options.bearer();
      if (current === null || current.length === 0) {
        return null;
      }
      const verified = await verifyStepUpChallengeViaHttp(
        options.authnBaseUrl,
        current,
        code,
      );
      if (verified.kind === "ok") {
        return verified.response.access_token;
      }
      if (verified.kind !== "invalid") {
        options.diag(
          `verification failed (${verified.kind}); continuing without a host credential.`,
        );
        return null;
      }
      if (attempt < MAX_CODE_ATTEMPTS) {
        process.stderr.write("That code was not accepted. Try again.\n");
      }
    }
    options.diag(
      "too many incorrect codes; continuing without a host credential.",
    );
    return null;
  } finally {
    rl.close();
  }
}

/**
 * Reads one line, or gives up after `PROMPT_TIMEOUT_MS`. `readline`'s question
 * promise never settles on its own if the user simply walks away, and this flow
 * runs inside a long-lived command that must not be held hostage by it.
 */
async function promptWithinBudget(
  rl: Interface,
  query: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROMPT_TIMEOUT_MS);
  try {
    return await rl.question(query, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Names the machine in Devices & Sessions. The CLI only ever reaches a host on
 * this same box (it dials the local pid metadata), so the local hostname really
 * is the host's machine - unlike the desktop, which may be talking to a remote
 * one and therefore leaves this to the directory.
 */
function hostLabel(): string | null {
  const name = hostname().trim();
  return name.length === 0 ? null : name;
}

/**
 * Carries the server's adoption tuple through verbatim. `familyId` and
 * `provisionedAt` are not derivable from the token, so anything that drops them
 * here leaves the host unable to order two credentials.
 */
function provisionedFrom(
  response: MintHostCredentialResponse,
): HostCredentialMintOutcome {
  return {
    kind: "provisioned",
    token: response.token,
    refreshToken: response.refreshToken,
    familyId: response.familyId,
    provisionedAt: response.provisionedAt,
    expiresIn: response.expiresIn,
  };
}
