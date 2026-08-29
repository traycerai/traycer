import { runDeviceAuthFlow } from "../auth/login-flow";
import {
  provisionInstalledHostCredential,
  type HostCredentialProvisionOutcome,
} from "./credential-provisioning";
import { resolveHostAuth, type HostAuth } from "../internal/host-auth";
import { errorFromUnknown } from "../logger";
import { toCliError } from "../runner/errors";
import type { CommandContext } from "../runner/runner";

// The sign-in pre-flight and post-start credential provisioning shared by
// every command that STARTS a host (client/host token split): the started
// host reads its owner from the shared credentials file, so starting one
// while signed out stands up a host that denies every connection
// ("unprovisioned"). Three commands start hosts - `host install` (unless
// `--no-service-register`), `host service install` (the deferred half of
// the documented split flow), and `host ensure` (the idempotent
// install+register+start) - and all three must own the same two steps, or
// any one of them silently recreates the unprovisioned-host regression the
// combined flow fixed.
//
// `host ensure` differs from the other two in one way that matters here:
// it is idempotent, so it alone has an action that starts NOTHING. `host
// install` always stages and swaps bytes, and `host service install`
// always registers + starts, so running the pre-flight unconditionally is
// right for both - whatever it reports is a fact about a host that command
// just started. Ensure's no-op has no such standing, so it hangs the
// pre-flight on `provisionHost`'s `beforeMutate` hook and reports
// `not-checked` when nothing ran. Wiring a start-capable command below,
// or giving one of the two above a no-op fast path, means answering the
// same question: does this run actually start a host?
//
// Deliberately NOT wired into the remaining start-capable commands, so this
// boundary is a decision rather than an omission:
//   - `host start` is the service manager's own entrypoint (what launchd/
//     systemd exec) - headless by contract, nothing to prompt, and a probe
//     there would have the starting host dial itself;
//   - `host restart` / `host free-port-and-restart` cycle an EXISTING
//     host whose provisioning state was set by whichever command installed
//     it - they create no new unprovisioned host, and a host that was
//     already unprovisioned self-heals on the next minting client.
//
// A fourth entry used to sit here: `maybeAutoBootstrap`, which started a
// host implicitly off `traycer host status`. It was excluded on the grounds
// that a device-flow login inside a status read is indefensible - and the
// note called itself "the weakest exclusion of the four and the one to
// revisit first". Revisiting it settled the question the other way round:
// the problem was never that auto-bootstrap sat outside this pre-flight, it
// was that a read installed software at all. The path is gone (audit finding
// CLI-001), so every remaining host-starting entry point is either an
// explicit lifecycle command that runs the pre-flight, or one of the three
// exclusions above.
//
// Pre-flight: a signed-out interactive run is offered the device-flow
// sign-in inline; a run that cannot prompt (JSON mode, CI, non-TTY stdout)
// warns and continues, and so does a declined or failed sign-in.
// Start-now-login-later stays legal throughout: the host picks up a later
// `traycer login` within one connection, no reinstall needed, which is why
// the guard never hard-fails.
//
// Provisioning: a signed-in run that started a host follows up with a
// short-lived stream connection carrying the CLI mint flow
// (`provisionInstalledHostCredential`), so the host comes up holding its own
// `aud: "host"` credential instead of waiting for the first minting client.
// Best-effort and deadline-bounded; failures warn.

// Outcome of the sign-in pre-flight, surfaced verbatim as `authPreflight`
// in the result payload so NDJSON consumers can tell an authorized run
// from one whose host will boot unprovisioned. The desktop's `result.data`
// parsers are tolerant of added fields.
export type HostInstallAuthPreflight =
  | { readonly state: "signed-in"; readonly reason: null }
  | { readonly state: "signed-in-inline"; readonly reason: null }
  | {
      readonly state: "unauthenticated";
      // Deliberately NOT split into declined-vs-failed: the device flow raises
      // `AUTH_REJECTED` for a user denial, an expired device code, a rejected
      // request, AND a post-auth token rejection alike (see `login-flow.ts`),
      // so any such split would report "declined" for four different outcomes.
      // The distinguishing detail lives where it is accurate - the human
      // warning line and the structured log below both carry the flow's own
      // message.
      readonly reason: "noninteractive-cannot-prompt" | "sign-in-incomplete";
    }
  // The pre-flight never ran, so this run asserts NOTHING about the
  // operator's auth state - distinct from `unauthenticated`, which is a
  // verified negative. `"nothing-to-start"` is `host ensure`'s no-op: it
  // started no host, so it has no standing to call one unprovisioned (an
  // already-running host can hold a live delegated credential long after a
  // local logout, since the host's `aud: "host"` credential lives in the
  // host's own store, not the CLI credentials file).
  | {
      readonly state: "not-checked";
      readonly reason: "bytes-only" | "nothing-to-start";
    };

export const SIGN_IN_LATER_HINT =
  "Run `traycer login` to authorize it - no reinstall needed.";

/**
 * `resolveHostAuth` returns `null` for "not signed in", but the credentials
 * read underneath it only maps ENOENT to `null` and rethrows every other fs
 * error - an unreadable file (EACCES on a foreign-owned credentials file,
 * EISDIR, EIO) throws.
 *
 * Neither caller here can act on that. The pre-flight's whole contract is
 * warn-and-continue, and the post-start probe runs after the bytes are
 * already swapped and the service started - letting a throw escape there would
 * report a successful command as a failure. Both read credentials
 * opportunistically, so an unreadable file is "no usable auth", logged and
 * carried on from.
 */
export async function resolveHostAuthOrNull(
  ctx: CommandContext,
  stage: "preflight" | "provision",
): Promise<HostAuth | null> {
  try {
    return await resolveHostAuth();
  } catch (err) {
    const error = errorFromUnknown(err);
    ctx.runtime.logger.warn(
      "Host install could not read the stored credentials; treating as signed out",
      {
        environment: ctx.runtime.environment,
        stage,
        errorName: error.name,
        errorMessage: error.message,
      },
    );
    return null;
  }
}

export async function runSignInPreflight(
  ctx: CommandContext,
  // Bytes-only installs start nothing, so there is no unauthenticated host
  // to prevent - the actor that later starts the service owns the sign-in
  // question (and calls this with `bytesOnly: false`).
  bytesOnly: boolean,
): Promise<HostInstallAuthPreflight> {
  if (bytesOnly) {
    return { state: "not-checked", reason: "bytes-only" };
  }
  const auth = await resolveHostAuthOrNull(ctx, "preflight");
  if (auth !== null) {
    return { state: "signed-in", reason: null };
  }
  // Prompting is only possible where a human can see the device-flow code
  // and act on it: human output mode, on a TTY, outside CI. The device-flow
  // instructions print via `humanRequired`, which is a no-op in JSON mode -
  // prompting there would silently block on a code nobody can read.
  const canPrompt =
    !ctx.runtime.nonInteractive &&
    !ctx.runtime.json &&
    process.stdout.isTTY === true;
  if (!canPrompt) {
    ctx.runtime.logger.warn(
      "Host install proceeding unauthenticated; cannot prompt for sign-in",
      {
        environment: ctx.runtime.environment,
        nonInteractive: ctx.runtime.nonInteractive,
        json: ctx.runtime.json,
      },
    );
    ctx.output.humanRequired(
      `warning: not signed in - the host this command starts will run unprovisioned and serve no work until you sign in. ${SIGN_IN_LATER_HINT}`,
    );
    return { state: "unauthenticated", reason: "noninteractive-cannot-prompt" };
  }
  ctx.output.humanRequired(
    "You are not signed in. The host this command starts runs unprovisioned\n" +
      "and serves no work until you sign in, so let's sign in first\n" +
      "(Ctrl+C cancels; a declined sign-in continues unauthenticated).",
  );
  try {
    const login = await runDeviceAuthFlow(ctx);
    ctx.output.humanRequired(
      `Signed in as ${login.user.email || login.user.name || login.user.id}.`,
    );
    return { state: "signed-in-inline", reason: null };
  } catch (err) {
    const cliErr = toCliError(err);
    ctx.runtime.logger.warn(
      "Host install inline sign-in did not complete; continuing unauthenticated",
      {
        environment: ctx.runtime.environment,
        code: cliErr.code,
        message: cliErr.message,
      },
    );
    ctx.output.humanRequired(
      `warning: sign-in did not complete (${cliErr.message})\n` +
        `Continuing - the host will start unprovisioned. ${SIGN_IN_LATER_HINT}`,
    );
    return { state: "unauthenticated", reason: "sign-in-incomplete" };
  }
}

// Overall budget for the post-start provisioning probe: host boot, mint,
// and adoption verification together. Typical success is a few seconds; the
// ceiling only binds when the host never comes up - where the command has a
// bigger problem than its credential.
const CREDENTIAL_PROVISION_DEADLINE_MS = 30_000;

export async function maybeProvisionCredential(
  ctx: CommandContext,
  postSwapAction: "start" | "install" | "none",
  authPreflight: HostInstallAuthPreflight,
): Promise<HostCredentialProvisionOutcome | null> {
  // Nothing was started, so there is nothing to dial - the one gate that
  // does not depend on the operator's auth state at all. Bytes-only lands
  // here too: its caller passes `"none"` because it deliberately skips the
  // whole service lifecycle.
  if (postSwapAction === "none") {
    return null;
  }
  const preflightSawSignIn =
    authPreflight.state === "signed-in" ||
    authPreflight.state === "signed-in-inline";
  // Re-read rather than trusting the pre-flight's verdict in EITHER
  // direction. It was taken before a stage + install that can run for
  // minutes, and the credentials file moves both ways across that window:
  // an inline sign-in or a concurrent `traycer login` in another terminal
  // makes an `unauthenticated` pre-flight stale exactly as a concurrent
  // sign-out makes a `signed-in` one stale. Gating on the stale verdict
  // skipped the probe for a run that had perfectly good credentials by the
  // time the host was up - and the file read is trivial next to the install
  // that just happened.
  //
  // Deliberately NOT gated on output mode - `--json` is the automation
  // surface that most needs a credentialed host, and a Desktop shellout
  // racing the GUI's own mint resolves inside the probe (a superseded mint
  // verifies the winner's credential rather than failing).
  const auth = await resolveHostAuthOrNull(ctx, "provision");
  if (auth === null) {
    // Still nothing to mint with. What that MEANS depends on what the
    // pre-flight saw: a sign-in that has since disappeared (concurrent
    // sign-out, corrupted file) must not be reported as a silent no-op -
    // the summary would claim a signed-in user with no provisioning attempt
    // while the just-started host cannot serve work, so it gets the one
    // outcome whose human line says the only thing that helps. A run that
    // was never signed in has already warned in the pre-flight and needs no
    // second verdict here.
    return preflightSawSignIn ? { kind: "unauthorized" } : null;
  }
  const progress = (message: string): void => {
    ctx.progress({
      stage: "host-credential",
      message,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
  };
  progress("authorizing the installed host (waiting for it to come up)...");
  // Belt and braces on the advisory contract. The probe maps its own failures
  // to an outcome and should never throw - but it runs AFTER the bytes are
  // swapped and the service started, so "should never" is not good enough
  // here: an escape would report a completed command as a failed one.
  let outcome: HostCredentialProvisionOutcome;
  try {
    outcome = await provisionInstalledHostCredential({
      environment: ctx.runtime.environment,
      auth,
      deadlineMs: CREDENTIAL_PROVISION_DEADLINE_MS,
      progress,
      logger: ctx.runtime.logger,
    });
  } catch (err) {
    const error = errorFromUnknown(err);
    ctx.runtime.logger.warn(
      "Host install credential provisioning threw; the install itself was unaffected",
      {
        environment: ctx.runtime.environment,
        errorName: error.name,
        errorMessage: error.message,
      },
    );
    outcome = { kind: "error", message: error.message };
  }
  ctx.runtime.logger.info("Host install credential provisioning settled", {
    environment: ctx.runtime.environment,
    outcome: outcome.kind,
  });
  return outcome;
}

// Terminal-line rendering of the provisioning outcome. `null` (not attempted)
// and "already credentialed" stay quiet; a fresh mint is confirmed; every
// failure is a warning that names the self-heal, because none of them makes
// the command itself less successful.
export function formatCredentialProvisionNote(
  outcome: HostCredentialProvisionOutcome | null,
): string | null {
  if (outcome === null) {
    return null;
  }
  const selfHeal = "it will be provisioned when a Traycer client next connects";
  switch (outcome.kind) {
    case "active":
      return outcome.minted ? "host credential provisioned" : null;
    case "unreachable":
      return `host credential not provisioned (the host did not come up in time) - ${selfHeal}`;
    case "unsupported":
      return "host credential not provisioned (this host cannot accept a delegated credential from this client)";
    case "mint-unavailable":
      return `host credential not provisioned (the credential handoff did not complete) - ${selfHeal}`;
    case "not-adopted":
      return `host credential not provisioned (the host did not adopt it in time) - ${selfHeal}`;
    // The one outcome that must NOT promise the self-heal: a dead sign-in
    // stops every other client from minting too, so the command leaves an
    // unusable host until the user actually signs in again.
    case "unauthorized":
      return `host credential not provisioned - your sign-in is no longer valid. ${SIGN_IN_LATER_HINT}`;
    case "error":
      return `host credential not provisioned (${outcome.message}) - ${selfHeal}`;
  }
}
