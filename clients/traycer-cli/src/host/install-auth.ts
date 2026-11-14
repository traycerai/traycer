import { TEAM_TRANSFER_DISCLOSURE } from "@traycer/protocol/host/environment/team-transfer-disclosure";
import { access } from "node:fs/promises";
import { readHostOwnershipViaHttp } from "@traycer-clients/shared/host-client/host-ownership";
import { mintTeamComputerInstallTokenBySlugViaHttp } from "@traycer-clients/shared/host-client/team-computer-install";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import {
  HostTransportFailureError,
  type HostTransportEndpoint,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  callHostRpcAtResolvedEndpoint,
  callHostRpcWithDispatch,
  PLAIN_DISPATCH,
  resolveEndpoint,
  hostRpcToCliError,
  toAgentCliError,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import {
  readCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";
import { cliCredentialsPath, hostEnrollmentRecordPath } from "../store/paths";
import type { Environment } from "../runner/environment";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";
import { runDeviceAuthFlow } from "../auth/login-flow";
import {
  provisionInstalledHostCredential,
  type HostCredentialProvisionOutcome,
} from "./credential-provisioning";
import {
  isValidLocalHostWebsocketUrl,
  publishedHostProcessGone,
  readHostPidMetadata,
} from "./pid-metadata";
import { resolveHostAuth, type HostAuth } from "../internal/host-auth";
import { errorFromUnknown } from "../logger";
import {
  CLI_ERROR_CODES,
  CliError,
  cliError,
  toCliError,
} from "../runner/errors";
import type { CommandContext } from "../runner/runner";
import { config } from "../config";
import { probeHostHealth } from "../service/health-probe";

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
//     it - they create no new unprovisioned host. A host that was already
//     unprovisioned stays that way until a minting client connects, and on
//     a machine without Desktop nothing does on its own: `traycer login`
//     is the CLI's way to credential a host that is already running
//     (`provisionRunningHostCredential` below).
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
// Without --team, a signed-out interactive run is offered the device-flow
// sign-in inline; a run that cannot prompt (JSON mode, CI, non-TTY stdout)
// warns and continues, and so does a declined or failed sign-in. A later
// `traycer login` can authorize the installed host without a reinstall.
// An attended team install requires sign-in before staging. On a machine with
// no host identity the sign-in mints the team's install token, which is staged
// before the service starts so the host's first start is as the team's; on a
// machine whose host is registered it authorizes the give. A piped install
// token instead authorizes the host directly, without reading the CLI sign-in.
//
// Provisioning: a signed-in run that started a host follows up with a
// short-lived stream connection carrying the CLI mint flow
// (`provisionInstalledHostCredential`), so the host comes up holding its own
// `aud: "host"` credential instead of waiting for the first minting client.
// Best-effort and deadline-bounded; failures warn.
//
// `traycer login` runs the same probe against a host that is ALREADY
// running on this machine (`provisionRunningHostCredential`), and nothing
// else: it never installs, downloads or starts one. That is the only CLI
// path that credentials a host left unprovisioned by an earlier run - a
// failed post-start probe, a host started while signed out, a sign-in that
// expired - without restarting it.

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
      readonly reason: "bytes-only" | "nothing-to-start" | "team-install-token";
    };

export const SIGN_IN_LATER_HINT =
  "Run `traycer login` to authorize it - no reinstall needed.";

/**
 * `resolveHostAuth` returns `null` for "not signed in", but the credentials
 * read underneath it only maps ENOENT to `null` and rethrows every other fs
 * error - an unreadable file (EACCES on a foreign-owned credentials file,
 * EISDIR, EIO) throws.
 *
 * An unreadable file is treated as no usable auth. Ordinary installs warn
 * and continue; a team install must sign in or refuse before staging.
 * The post-start probe runs after the bytes are swapped and the service
 * started, so its credential read cannot fail the completed install.
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
  // question (and calls this with false). A team transfer instead requires
  // sign-in here: a later login does not finish giving the computer to a team.
  policy:
    | boolean
    | {
        readonly requireSignIn: true;
        readonly onInlineSignIn?: (token: string) => void;
      },
): Promise<HostInstallAuthPreflight> {
  if (policy === true) {
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
    if (typeof policy === "object") {
      throw cliError({
        code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
        message:
          "Sign in with `traycer login`, then run the command with --team again. No host files were installed.",
        details: null,
        exitCode: 1,
      });
    }
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
    typeof policy === "object"
      ? "Sign in to add this computer to the team. Ctrl+C cancels."
      : "You are not signed in. The host this command starts runs unprovisioned\n" +
          "and serves no work until you sign in, so let's sign in first\n" +
          "(Ctrl+C cancels; a declined sign-in continues unauthenticated).",
  );
  try {
    const login = await runDeviceAuthFlow(ctx);
    if (typeof policy === "object") policy.onInlineSignIn?.(login.token);
    const identity = login.user.email || login.user.name;
    ctx.output.humanRequired(
      identity ? `Signed in as ${identity}.` : "Signed in.",
    );
    return { state: "signed-in-inline", reason: null };
  } catch (err) {
    const cliErr = toCliError(err);
    if (typeof policy === "object") throw cliErr;
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
  const outcome = await provisionWithStoredAuth(
    ctx,
    "authorizing the installed host (waiting for it to come up)...",
  );
  if (outcome === "signed-out") {
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
  return outcome;
}

/**
 * `traycer login`'s follow-up: hands a host that is ALREADY running on this
 * machine its credential, using the sign-in the login just stored. `null`
 * when there is no such host - no pid record, an endpoint that is not a
 * local host's, or a recorded process that is provably gone - and then
 * nothing is dialed, installed or started.
 *
 * The probe itself decides whether a mint is needed: a host that already
 * holds a credential acks `active` on the first connection and nothing is
 * minted.
 */
export async function provisionRunningHostCredential(
  ctx: CommandContext,
): Promise<HostCredentialProvisionOutcome | null> {
  const environment = ctx.runtime.environment;
  const metadata = await readHostPidMetadata(environment);
  if (
    metadata === null ||
    !isValidLocalHostWebsocketUrl(metadata.websocketUrl) ||
    publishedHostProcessGone(metadata)
  ) {
    ctx.runtime.logger.info(
      "Login found no running host to provision a credential for",
      { environment, hasPidMetadata: metadata !== null },
    );
    return null;
  }
  const outcome = await provisionWithStoredAuth(
    ctx,
    "authorizing the running host...",
  );
  // The login that just returned stored this sign-in, so losing it here is a
  // concurrent sign-out or an unreadable file - either way the host was not
  // given a credential, and signing in again is the remedy.
  return outcome === "signed-out" ? { kind: "unauthorized" } : outcome;
}

async function provisionWithStoredAuth(
  ctx: CommandContext,
  progressMessage: string,
): Promise<HostCredentialProvisionOutcome | "signed-out"> {
  const auth = await resolveHostAuthOrNull(ctx, "provision");
  if (auth === null) {
    return "signed-out";
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
  progress(progressMessage);
  // Belt and braces on the advisory contract. The probe maps its own failures
  // to an outcome and should never throw - but it runs AFTER the command's
  // own work is done (bytes swapped and the service started, or the sign-in
  // stored), so "should never" is not good enough here: an escape would
  // report a completed command as a failed one.
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
      "Host credential provisioning threw; the command itself was unaffected",
      {
        environment: ctx.runtime.environment,
        errorName: error.name,
        errorMessage: error.message,
      },
    );
    outcome = { kind: "error", message: error.message };
  }
  ctx.runtime.logger.info("Host credential provisioning settled", {
    environment: ctx.runtime.environment,
    outcome: outcome.kind,
  });
  return outcome;
}

// Terminal-line rendering of the provisioning outcome. `null` (not attempted)
// and "already credentialed" stay quiet; a fresh mint is confirmed; every
// failure is a warning, because none of them makes the command itself less
// successful. No failure outcome observed the host reporting `active` - and
// most never observed its state at all - so they say the authorization is
// not confirmed rather than asserting the host lacks one. They point at
// `traycer host doctor` rather than promising that a later client will fix
// it: on a machine without Desktop no client connects on its own, and the
// doctor reports a host left without its credential.
export function formatCredentialProvisionNote(
  outcome: HostCredentialProvisionOutcome | null,
): string | null {
  if (outcome === null) {
    return null;
  }
  const nextStep = "run `traycer host doctor` to see how to fix it";
  switch (outcome.kind) {
    case "active":
      return outcome.minted ? "host authorized" : null;
    case "team-unavailable":
      return "the team's computer is waiting to reconnect; no personal sign-in is needed";
    case "unreachable":
      return `host authorization not confirmed (the host did not respond in time) - ${nextStep}`;
    case "unsupported":
      return "host authorization not confirmed - update the Traycer CLI using your install method, run `traycer host update`, then `traycer login`";
    case "mint-unavailable":
      return `host authorization not confirmed (the authorization did not complete) - ${nextStep}`;
    case "not-adopted":
      return `host authorization not confirmed (the host did not confirm it in time) - ${nextStep}`;
    // A dead sign-in stops every client from minting, so the one thing that
    // helps is signing in again - say that directly.
    case "unauthorized":
      return `host authorization not confirmed - your sign-in is no longer valid. ${SIGN_IN_LATER_HINT}`;
    case "error":
      return `host authorization not confirmed - ${nextStep}`;
  }
}

export interface TeamInstallAuthSession {
  readonly preflight: HostInstallAuthPreflight;
  /** Kept only in the command; never included in its result or logs. */
  readonly inlineSignInToken: string | null;
}

async function runTeamInstallAuthPreflight(
  ctx: CommandContext,
): Promise<TeamInstallAuthSession> {
  let inlineSignInToken: string | null = null;
  const preflight = await runSignInPreflight(ctx, {
    requireSignIn: true,
    onInlineSignIn: (token) => {
      inlineSignInToken = token;
    },
  });
  return { preflight, inlineSignInToken };
}

/** Failed setup retains the command-created sign-in until transfer is confirmed. */
export async function warnIfTeamInstallSignInRemains(
  ctx: CommandContext,
  session: TeamInstallAuthSession | null,
): Promise<void> {
  if (session === null || session.inlineSignInToken === null) return;
  let credentials: StoredCredentials | null;
  try {
    credentials = await readCredentialsFile(
      cliCredentialsPath(ctx.runtime.environment),
    );
  } catch {
    ctx.output.humanRequired(
      "Your sign-in could still be on this computer. Run `traycer logout` to remove it.",
    );
    return;
  }
  if (credentials === null) return;
  // A refresh can supersede the token this command created. Exact-token
  // deletion must preserve a replacement, but its presence still needs the
  // manual sign-out warning.
  if (credentials.token !== session.inlineSignInToken) {
    ctx.output.humanRequired(
      "Your sign-in could still be on this computer. Run `traycer logout` to remove it.",
    );
    return;
  }
  ctx.output.humanRequired(
    "Your sign-in stays on this computer. Run `traycer logout` to remove it.",
  );
}

/** A team is named by its slug; `team/<slug>` is accepted as typed elsewhere. */
export function teamSlugFromSelector(team: string): string {
  return team.startsWith("team/") ? team.slice(5) : team;
}

const NOT_A_TEAM_YOU_BELONG_TO =
  "Enter the slug of a team you belong to, as shown in its dashboard address.";

/** Printed once a new computer has enrolled as the team's. */
export function teamEnrolmentConfirmation(slug: string): string {
  return `This computer belongs to ${slug}.`;
}

/**
 * An attended `--team` run, after its sign-in. A machine with no host identity
 * yet enrols as the team's with a token this run mints; a machine whose host
 * is already registered takes the give, because authn refuses a token for a
 * host it knows and the token path carries no consent.
 */
export type AttendedTeamInstall =
  | {
      readonly kind: "enrol";
      readonly session: TeamInstallAuthSession;
      readonly slug: string;
      /** Kept only in the command; never included in its result or logs. */
      readonly token: string;
      readonly environmentId: string;
    }
  | { readonly kind: "give"; readonly session: TeamInstallAuthSession };

export async function beginAttendedTeamInstall(
  ctx: CommandContext,
  team: string,
): Promise<AttendedTeamInstall> {
  const session = await runTeamInstallAuthPreflight(ctx);
  if (await hostIdentityMayExist(ctx.runtime.environment)) {
    return { kind: "give", session };
  }
  const slug = teamSlugFromSelector(team);
  const auth = await resolveHostAuthOrNull(ctx, "preflight");
  if (auth === null) throw teamInstallSignInRequired();
  const minted = await mintTeamComputerInstallTokenBySlugViaHttp(
    auth.authnBaseUrl,
    auth.token,
    slug,
  );
  ctx.runtime.logger.info("Team install token request settled", {
    environment: ctx.runtime.environment,
    outcome: minted.kind,
    code: minted.kind === "refused" ? minted.code : null,
  });
  switch (minted.kind) {
    case "ok":
      return {
        kind: "enrol",
        session,
        slug,
        token: minted.token,
        environmentId: minted.environmentId,
      };
    case "unauthorized":
      throw teamInstallSignInRequired();
    case "refused":
      if (minted.code === "environment_not_found") {
        throw cliError({
          code: CLI_ERROR_CODES.INVALID_ARGUMENT,
          message: NOT_A_TEAM_YOU_BELONG_TO,
          details: null,
          exitCode: 1,
        });
      }
      throw teamEnrolmentNotStarted(CLI_ERROR_CODES.AUTH_REJECTED);
    case "network-error":
      throw teamEnrolmentNotStarted(CLI_ERROR_CODES.AUTH_NETWORK);
  }
}

function teamInstallSignInRequired(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
    message:
      "Sign in with `traycer login`, then run the command with --team again. No host files were installed.",
    details: null,
    exitCode: 1,
  });
}

function teamEnrolmentNotStarted(
  code:
    | typeof CLI_ERROR_CODES.AUTH_REJECTED
    | typeof CLI_ERROR_CODES.AUTH_NETWORK,
): CliError {
  return cliError({
    code,
    message:
      "The computer was not added to the team. No host files were installed.",
    details: null,
    exitCode: 1,
  });
}

/**
 * The enrolment record is written once the host has registered, as a
 * person's or a team's. Only its proven absence picks the token path: an
 * unreadable record takes the give, which asks for consent, rather than a
 * token authn would refuse for a known host.
 */
async function hostIdentityMayExist(
  environment: Environment,
): Promise<boolean> {
  try {
    await access(hostEnrollmentRecordPath(environment));
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
}

/** The one team transfer used by host use, install --team and ensure --team. */
export async function useInstalledHostTeam(
  team: string,
  progress: CommandContext["progress"],
): Promise<EnvironmentHostBinding> {
  const dispatch = {
    ...PLAIN_DISPATCH,
    requiredHostMethodVersion: {
      method: "environment.host.bind",
      version: { major: 1, minor: 1 },
    },
  };
  const selector = teamSlugFromSelector(team);
  const { environments } = await toAgentCliError(
    callHostRpcWithDispatch("environment.list", {}, dispatch),
  );
  const teams = environments.filter(
    (environment) => environment.ownerKind === "organization",
  );
  const exactMatches = teams.filter(
    (environment) =>
      environment.environmentId === selector ||
      environment.providerHandle === selector,
  );
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : teams.filter((environment) => environment.label === selector);
  if (matches.length !== 1) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: NOT_A_TEAM_YOU_BELONG_TO,
      details: null,
      exitCode: 1,
    });
  }
  const target = matches[0];
  const endpoint = await resolveEndpoint();
  const auth = await resolveHostAuth();
  if (auth === null) {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      message: "Sign in with `traycer login`, then run the command again.",
      details: null,
      exitCode: 1,
    });
  }
  const directory = await readHostOwnershipViaHttp(
    auth.authnBaseUrl,
    auth.token,
    endpoint.hostId,
  );
  const host = directory.kind === "ok" ? directory.host : undefined;
  if (host === undefined) {
    throw cliError({
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message: "This computer's ownership could not be confirmed. Try again.",
      details: null,
      exitCode: 1,
    });
  }
  if (host.kind === "sandbox") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_IS_SANDBOX,
      message:
        "Run this command on the computer you want to add, rather than a sandbox.",
      details: null,
      exitCode: 1,
    });
  }
  if (host.owner.kind === "team") {
    const current = await toAgentCliError(
      callHostRpcAtResolvedEndpoint(
        "environment.host.read",
        {},
        endpoint,
        auth,
        dispatch,
      ),
    );
    if (
      host.owner.id === target.ownerId &&
      current.environment.environmentId === target.environmentId &&
      current.explicit
    ) {
      return current;
    }
    throw cliError({
      code: CLI_ERROR_CODES.HOST_IN_ANOTHER_TEAM,
      message:
        "Claim this computer from its current team before adding it to another.",
      details: null,
      exitCode: 1,
    });
  }
  for (const message of TEAM_TRANSFER_DISCLOSURE) {
    progress({
      stage: "host-team",
      message,
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
  }
  // A Local computer has no environment binding to read before its transfer.
  progress({
    stage: "host-team",
    message: `Restarting Traycer on this computer to run as ${target.label}…`,
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
  });
  return transferInstalledHostTeam(endpoint, auth, target, dispatch, true);
}

async function transferInstalledHostTeam(
  endpoint: HostTransportEndpoint,
  auth: HostAuth,
  target: EnvironmentDescriptor,
  dispatch: HostRpcDispatch,
  mayRetry: boolean,
): Promise<EnvironmentHostBinding> {
  const previous = await readHostPidMetadata(config.environment);
  let binding: EnvironmentHostBinding;
  try {
    binding = await callHostRpcAtResolvedEndpoint(
      "environment.host.bind",
      { environmentId: target.environmentId },
      endpoint,
      auth,
      dispatch,
    );
  } catch (error) {
    const mapped = hostRpcToCliError(error);
    if (
      !(error instanceof HostTransportFailureError) ||
      !(mapped instanceof CliError) ||
      mapped.code !== CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN
    )
      throw mapped;
    if (
      previous === null ||
      previous.hostId !== endpoint.hostId ||
      previous.websocketUrl !== endpoint.websocketUrl
    )
      throw mapped;

    // The transfer can commit and restart this host before its reply is sent.
    const ownership = await readHostOwnershipViaHttp(
      auth.authnBaseUrl,
      auth.token,
      endpoint.hostId,
    );
    if (
      ownership.kind !== "ok" ||
      (ownership.host.owner.kind === "team" &&
        ownership.host.owner.id !== target.ownerId)
    )
      throw mapped;

    const recovery: {
      ready: {
        readonly endpoint: HostTransportEndpoint;
        readonly binding: EnvironmentHostBinding | null;
      } | null;
    } = { ready: null };
    const health = await probeHostHealth({
      environment: config.environment,
      checkProcessAlive: null,
      checkTcpReachable: null,
      checkReadiness: async (metadata, remainingMs) => {
        if (
          metadata.hostId !== endpoint.hostId ||
          metadata.pid === previous.pid ||
          remainingMs <= 0
        )
          return false;
        const replacement = {
          hostId: endpoint.hostId,
          websocketUrl: metadata.websocketUrl,
        };
        try {
          const bounded = {
            ...dispatch,
            signal: AbortSignal.timeout(remainingMs),
            responseTimeoutMs: Math.min(2_000, remainingMs),
          };
          if (ownership.host.owner.kind === "user") {
            const status = await callHostRpcAtResolvedEndpoint(
              "host.status",
              {},
              replacement,
              auth,
              bounded,
            );
            if (!status.ready) return false;
            recovery.ready = { endpoint: replacement, binding: null };
            return true;
          }
          const current = await callHostRpcAtResolvedEndpoint(
            "environment.host.read",
            {},
            replacement,
            auth,
            bounded,
          );
          if (
            !current.explicit ||
            current.environment.environmentId !== target.environmentId
          )
            return false;
          recovery.ready = { endpoint: replacement, binding: current };
          return true;
        } catch {
          return false;
        }
      },
      totalBudgetMs: null,
      retryDelayMs: null,
    });
    const ready = recovery.ready;
    if (!health.healthy || ready === null) throw mapped;
    const confirmed = await readHostOwnershipViaHttp(
      auth.authnBaseUrl,
      auth.token,
      endpoint.hostId,
    );
    if (confirmed.kind !== "ok") throw mapped;
    if (
      ownership.host.owner.kind === "user" &&
      confirmed.host.owner.kind === "user" &&
      mayRetry
    ) {
      const refreshed = await resolveHostAuth();
      if (refreshed === null) throw mapped;
      return transferInstalledHostTeam(
        ready.endpoint,
        refreshed,
        target,
        dispatch,
        false,
      );
    }
    if (
      confirmed.host.owner.kind !== "team" ||
      confirmed.host.owner.id !== target.ownerId ||
      ready.binding === null ||
      !ready.binding.explicit ||
      ready.binding.environment.environmentId !== target.environmentId
    )
      throw mapped;
    return ready.binding;
  }
  const confirmed = await readHostOwnershipViaHttp(
    auth.authnBaseUrl,
    auth.token,
    endpoint.hostId,
  );
  const owner = confirmed.kind === "ok" ? confirmed.host.owner : undefined;
  if (
    owner?.kind !== "team" ||
    owner.id !== target.ownerId ||
    binding.environment.environmentId !== target.environmentId ||
    !binding.explicit
  ) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "The team transfer could not be confirmed. Check this computer in the app before trying again.",
      details: null,
      exitCode: 1,
    });
  }
  return binding;
}

export async function completeTeamInstall(
  team: string,
  session: TeamInstallAuthSession,
  progress: CommandContext["progress"],
): Promise<EnvironmentHostBinding> {
  const binding = await useInstalledHostTeam(team, progress);
  if (session.inlineSignInToken !== null) {
    const token = session.inlineSignInToken;
    const outcome = await runWithCliStore((store) =>
      withCommitRetry(() => store.signOutIfToken(token, null), null),
    );
    if (outcome.outcome !== "deleted" && outcome.outcome !== "superseded") {
      throw cliError({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message:
          "The computer was added to the team, but its temporary sign-in could not be cleared. Run `traycer logout` on this computer.",
        details: null,
        exitCode: 1,
      });
    }
  }
  return binding;
}
