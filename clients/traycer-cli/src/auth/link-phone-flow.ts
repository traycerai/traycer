import { createInterface } from "node:readline";
import QRCode from "qrcode";
import {
  buildLinkLoginQrPayload,
  claimantDeviceLabel,
  linkLoginStatusViaHttp,
  mintLinkLoginCodeViaHttp,
  respondLinkLoginViaHttp,
  type MintLinkLoginCodeFetchResult,
} from "../../../shared/auth/link-login";
import type {
  LinkLoginStatusResponse,
  MintLinkLoginCodeResponse,
} from "@traycer/protocol/auth/link-login";
import { config } from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandContext } from "../runner/runner";
import { validateStoredCredentials } from "./validate";

/**
 * `traycer link-phone` - the terminal's half of the confirm-gated QR handoff.
 *
 * This CLI is the MINTER, not the phone: it prints a public code (as an ANSI QR
 * and as typeable text), watches it, and asks the human at this terminal to
 * approve the phone that scans it. A scan alone signs nothing in; the approval
 * here does, and only for the claimant whose metadata is shown.
 *
 * The server keeps at most ONE live unclaimed code per account, across every
 * surface. So a code printed here can be superseded by a mint elsewhere (the
 * desktop panel, the web portal), which this flow reports and exits on rather
 * than leaving a dead QR on screen.
 */

// One rotation of the printed code, comfortably inside its 60s server TTL so a
// phone scanning just before rotation still has seconds to claim.
const LINK_PHONE_REMINT_MS = 50_000;

// Matches the claim window's pacing: a scan becomes a prompt at this terminal
// while the phone is still in the user's hand.
const LINK_PHONE_POLL_INTERVAL_MS = 2_000;

export type LinkPhoneDecision = "approved" | "rejected";

export interface LinkPhoneResult {
  readonly decision: LinkPhoneDecision;
  readonly claimant: {
    readonly address: string | null;
    readonly location: string | null;
    readonly userAgent: string | null;
  };
}

/**
 * Encodes the code as an ANSI QR. Returns `null` when the encoder refuses,
 * which is not fatal: the typeable code beside it is the guaranteed path, the
 * same way the device flow's printed `user_code` is.
 */
async function renderQr(code: string): Promise<string | null> {
  try {
    // `cloudUiBaseUrl` IS the platform origin the QR's universal link
    // addresses, and it already carries this CLI's dev-gated override - so a
    // terminal pointed at a dev deploy prints a QR for that deploy.
    return await QRCode.toString(
      buildLinkLoginQrPayload(config.cloudUiBaseUrl, code),
      {
        type: "terminal",
        // Half-block glyphs: a v2 matrix fits an 80-column terminal, where the
        // full-size rendering is twice as wide and wraps into noise.
        small: true,
        errorCorrectionLevel: "M",
      },
    );
  } catch {
    return null;
  }
}

/**
 * Transient chrome: a single stderr line rewritten in place until the code
 * rotates. It bypasses the output sink on purpose - that sink is line-oriented
 * and feeds the NDJSON stream, and a carriage-returned counter is neither a log
 * line nor an event. The caller only starts it on an interactive, non-quiet
 * run.
 */
function startExpiryCountdown(expiresAtEpochSeconds: number): () => void {
  const tick = (): void => {
    const secondsLeft = Math.max(
      0,
      Math.ceil(expiresAtEpochSeconds - Date.now() / 1_000),
    );
    process.stderr.write(`\r  Code expires in ${secondsLeft}s   `);
  };
  tick();
  const timer = setInterval(tick, 1_000);
  return () => {
    clearInterval(timer);
    // Blank the line so the next block starts clean.
    process.stderr.write(`\r${" ".repeat(40)}\r`);
  };
}

/**
 * Asks the human at this terminal. Defaults to NO on anything but an explicit
 * yes, including a bare newline: the confirm gate exists to make an unwanted
 * sign-in take a deliberate keystroke. Prompt and echo go to stderr so a piped
 * stdout carries only the command's own output.
 */
async function askApproval(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      // Registered BEFORE `question`, not after: stdin can already be at EOF
      // when the prompt goes up (a piped or closed input), in which case the
      // close lands during `question` itself and a listener attached on the
      // next line would never hear it - the flow then waits forever on an
      // answer that can no longer come.
      //
      // Ctrl-D ends the stream without ever answering, and `question`'s
      // callback never fires. Closing is not a yes, so it resolves to the same
      // empty answer a bare newline gives and the default-to-NO rule below
      // does the rest.
      rl.once("close", () => {
        resolve("");
      });
      rl.question(question, resolve);
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves the bearer this flow mints under. Mirrors `whoami`'s vocabulary so
 * "not signed in" and "the service is unreachable" stay distinguishable in a
 * script's exit code.
 */
async function requireBearerToken(): Promise<string> {
  const validation = await validateStoredCredentials();
  if (validation.kind === "network-error") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NETWORK,
      message: "Could not reach the authn service; check your network.",
      details: null,
      exitCode: 2,
    });
  }
  if (validation.kind === "no-credentials") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message: "Not logged in. Run `traycer login` first.",
      details: null,
      exitCode: 1,
    });
  }
  if (validation.kind === "rejected") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "Stored credentials were rejected by the authn service. Run `traycer login` to re-authenticate.",
      details: null,
      exitCode: 1,
    });
  }
  return validation.credentials.token;
}

function mintFailure(outcome: MintLinkLoginCodeFetchResult): never {
  switch (outcome.kind) {
    case "claim-pending":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "A sign-in request is already awaiting your approval. Answer it where the code was shown, then run `traycer link-phone` again.",
        details: null,
        exitCode: 1,
      });
    case "no-session-family":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "This credential cannot mint a link code. Run `traycer login` to re-authenticate, then try again.",
        details: null,
        exitCode: 1,
      });
    case "unauthorized":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "The stored credential was rejected. Run `traycer login` to re-authenticate.",
        details: null,
        exitCode: 1,
      });
    case "network-error":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_NETWORK,
        message: "Could not reach the authn service; check your network.",
        details: null,
        exitCode: 2,
      });
    case "ok":
      throw cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: "link-phone: a successful mint reached the failure path.",
        details: null,
        exitCode: 1,
      });
  }
}

/** Prints one code: the QR (unless suppressed), the typeable text, the hint. */
async function printCode(
  ctx: CommandContext,
  minted: MintLinkLoginCodeResponse,
  showQr: boolean,
): Promise<void> {
  const qr = showQr ? await renderQr(minted.code) : null;
  ctx.output.humanRequired(
    `${qr === null ? "" : `${qr}\n`}` +
      `In the Traycer mobile app, choose "Scan QR code" - or type this code:\n` +
      `  ${minted.code}\n\n` +
      `Each code signs in one phone, expires in ${minted.expires_in}s, and needs your approval here.`,
  );
  ctx.progress({
    stage: "link-code-shown",
    message: `Waiting for a phone to scan ${minted.code}`,
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
  });
}

interface WatchedCode {
  readonly minted: MintLinkLoginCodeResponse;
  readonly rotateAtMs: number;
}

/**
 * Watches the printed code until a phone claims it, rotating the code whenever
 * the current one nears expiry. Returns the claim, or throws the terminal state
 * that ended the watch.
 */
async function watchUntilClaimed(
  ctx: CommandContext,
  bearerToken: string,
  showQr: boolean,
  quiet: boolean,
): Promise<{
  readonly code: string;
  readonly claimant: NonNullable<LinkLoginStatusResponse["claimant"]>;
}> {
  const { authnBaseUrl } = config;

  // `claim-pending` is returned rather than fatal: at ROTATION time it means a
  // phone claimed the code on screen since the last poll and the server refuses
  // to rotate over a live claim - which is success, not failure. The first mint
  // has no such code to fall back on, so the caller below still treats it as
  // terminal there.
  const mintAndPrint = async (): Promise<WatchedCode | "claim-pending"> => {
    const outcome = await mintLinkLoginCodeViaHttp(
      authnBaseUrl,
      bearerToken,
      null,
    );
    if (outcome.kind === "claim-pending") {
      return "claim-pending";
    }
    if (outcome.kind !== "ok") {
      mintFailure(outcome);
    }
    await printCode(ctx, outcome.response, showQr);
    return {
      minted: outcome.response,
      rotateAtMs: Date.now() + LINK_PHONE_REMINT_MS,
    };
  };

  const first = await mintAndPrint();
  if (first === "claim-pending") {
    mintFailure({ kind: "claim-pending" });
  }
  let watched: WatchedCode = first;
  let stopCountdown = quiet
    ? () => {}
    : startExpiryCountdown(watched.minted.expires_at);

  try {
    for (;;) {
      await sleep(LINK_PHONE_POLL_INTERVAL_MS);

      // Rotation runs BEFORE the status call, so a status outage cannot park a
      // dead QR on screen: an unreachable service fails the mint instead and
      // exits, while a status-only outage still reprints a live code. Leaving
      // it after the call meant a `network-error` skipped it entirely.
      if (Date.now() >= watched.rotateAtMs) {
        stopCountdown();
        const next = await mintAndPrint();
        // Refused because the displayed code was claimed between the last poll
        // and now. Keep it on screen; the poll just below surfaces the claim.
        watched =
          next === "claim-pending"
            ? {
                minted: watched.minted,
                rotateAtMs: Date.now() + LINK_PHONE_POLL_INTERVAL_MS,
              }
            : next;
        stopCountdown = quiet
          ? () => {}
          : startExpiryCountdown(watched.minted.expires_at);
      }

      const status = await linkLoginStatusViaHttp(
        authnBaseUrl,
        bearerToken,
        watched.minted.code,
        null,
      );

      if (status.kind === "unauthorized") {
        throw cliError({
          code: CLI_ERROR_CODES.AUTH_REJECTED,
          message:
            "The stored credential was rejected while waiting. Run `traycer login` to re-authenticate.",
          details: null,
          exitCode: 1,
        });
      }
      if (status.kind === "gone") {
        // Unknown, expired, consumed and SUPERSEDED all read alike here. The
        // code was rotated well inside its TTL, so in practice this is another
        // surface having minted over it - and only one code per account can be
        // live, so this one will never be claimable again.
        throw cliError({
          code: CLI_ERROR_CODES.AUTH_REJECTED,
          message:
            "This code was replaced by one minted somewhere else (the desktop app or the web portal). Use that code, or run `traycer link-phone` again.",
          details: null,
          exitCode: 1,
        });
      }
      if (status.kind === "network-error") {
        // Transient: keep watching. The rotation check at the top of the loop
        // bounds how long an unclaimable code can stay on screen.
        continue;
      }

      const { status: state, claimant } = status.response;
      if (state === "claimed" && claimant !== null) {
        return { code: watched.minted.code, claimant };
      }
      if (state === "claimed") {
        // The schema permits `claimed` with a null claimant, and there is
        // nothing to show or approve in that state: the prompt IS the claimant
        // metadata. Polling on would spin until the code expired while the
        // phone waits on a decision this terminal can never ask for.
        throw cliError({
          code: CLI_ERROR_CODES.AUTH_REJECTED,
          message:
            "A phone claimed this code but reported nothing about itself, so there is nothing to confirm. Run `traycer link-phone` again for a fresh code.",
          details: null,
          exitCode: 1,
        });
      }
      if (state === "approved" || state === "denied") {
        throw cliError({
          code: CLI_ERROR_CODES.AUTH_REJECTED,
          message:
            "This request was already decided somewhere else. Run `traycer link-phone` again to link another phone.",
          details: null,
          exitCode: 1,
        });
      }
    }
  } finally {
    stopCountdown();
  }
}

/**
 * Runs the whole flow: authenticate, mint, print, watch, ask, decide.
 *
 * Interrupting at any point before the decision is safe and needs no cleanup -
 * an unclaimed code is not a grant, and it dies with its own TTL.
 */
export async function runLinkPhoneFlow(
  ctx: CommandContext,
  options: { readonly showQr: boolean },
): Promise<LinkPhoneResult> {
  // The decision is the whole point of this command, and only a human at this
  // terminal can give it. Refuse up front rather than printing a QR nobody can
  // approve.
  if (ctx.runtime.json || ctx.runtime.nonInteractive) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "link-phone needs an interactive terminal: it asks you to approve the phone that scans the code.",
      details: null,
      exitCode: 1,
    });
  }
  if (process.stdin.isTTY !== true) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "link-phone needs stdin attached to a terminal to read your approval.",
      details: null,
      exitCode: 1,
    });
  }

  const bearerToken = await requireBearerToken();
  const claim = await watchUntilClaimed(
    ctx,
    bearerToken,
    options.showQr,
    ctx.runtime.quiet,
  );

  const detail = [
    claim.claimant.address ?? "address unknown",
    claim.claimant.location ?? "location unknown",
  ].join(" · ");
  ctx.output.humanRequired(
    `A phone scanned the code.\n` +
      `  ${detail}\n` +
      `Details are approximate. Only approve if you scanned this code yourself.`,
  );

  const approve = await askApproval(
    `Approve sign-in from ${claimantDeviceLabel(claim.claimant.userAgent)} · ${claim.claimant.address ?? "address unknown"}? [y/N] `,
  );

  const responded = await respondLinkLoginViaHttp(
    config.authnBaseUrl,
    bearerToken,
    claim.code,
    approve,
  );
  switch (responded.kind) {
    case "ok":
      break;
    case "already-decided":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "This request was already decided somewhere else; your answer was not applied.",
        details: null,
        exitCode: 1,
      });
    case "gone":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "The request expired before your answer reached the service. Run `traycer link-phone` again.",
        details: null,
        exitCode: 1,
      });
    case "unauthorized":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message:
          "The stored credential was rejected. Run `traycer login` to re-authenticate.",
        details: null,
        exitCode: 1,
      });
    case "network-error":
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_NETWORK,
        message:
          "Could not reach the authn service to record your answer; the request will expire on its own.",
        details: null,
        exitCode: 2,
      });
  }

  return {
    decision: approve ? "approved" : "rejected",
    claimant: {
      address: claim.claimant.address,
      location: claim.claimant.location,
      userAgent: claim.claimant.userAgent,
    },
  };
}
