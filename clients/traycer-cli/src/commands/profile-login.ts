import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
  type ProviderCliState,
  type ProviderId,
  type ProviderLoginRefusal,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "../../../shared/host-transport/host-messenger";
import { openInBrowser } from "../auth/login-flow";
import {
  callHostRpc,
  callHostRpcWithDispatch,
  PLAIN_DISPATCH,
  toAgentCliError,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import {
  describeProvider,
  isAmbientProfileId,
  parseProfileArgument,
  parseProviderArgument,
  printable,
} from "../internal/profile-target";
import { CLI_ERROR_CODES, cliError, type CliError } from "../runner/errors";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../runner/runner";
import { summarizeProfile, type ProfileListRow } from "./profile-list";
import { parseProfileLabel } from "./profile-mutations";

type StartLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type StartLoginAnswer = ResponseOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
type AwaitLoginResult = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;

/** What the command is signing in: a new managed profile, or an existing row. */
export type ProfileLoginTarget =
  | { readonly kind: "create"; readonly label: string | null }
  | { readonly kind: "existing"; readonly profile: string };

/**
 * The process edges of a sign-in, named so a test can drive the flow without
 * a terminal, a browser or a clock.
 */
export interface ProfileLoginIo {
  readonly newHolderId: () => string;
  /** Whether stdin is a terminal a person can type into. */
  readonly stdinIsTerminal: () => boolean;
  readonly openUrl: (url: string) => void;
  readonly wait: (ms: number) => Promise<void>;
  /** Calls `handler` on Ctrl+C until the returned function is called. */
  readonly onInterrupt: (handler: () => void) => () => void;
  /**
   * Feeds each line typed on stdin to `onLine` until the returned function is
   * called, or null when there is no terminal to type into.
   */
  readonly readLines: (
    onLine: (line: string) => void,
    onInterrupt: () => void,
  ) => (() => void) | null;
}

export const PROCESS_PROFILE_LOGIN_IO: ProfileLoginIo = {
  newHolderId: () => randomUUID(),
  stdinIsTerminal: () => process.stdin.isTTY === true,
  openUrl: openInBrowser,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onInterrupt: (handler) => {
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
  },
  readLines: (onLine, onInterrupt) => {
    if (process.stdin.isTTY !== true) return null;
    const lines = createInterface({ input: process.stdin });
    lines.on("line", onLine);
    // Ctrl+C reaches the process handler while this interface has no output
    // stream; were it ever given one, readline would take the key itself and
    // report it here instead.
    lines.on("SIGINT", onInterrupt);
    return () => lines.close();
  },
};

/**
 * `profileId` reached `providers.awaitLogin` at 2.1. Below it the field is
 * dropped and the wait lands on the ambient login, not the profile being
 * signed in, so the wait names its floor like the start and the cancel do.
 */
const AWAIT_LOGIN_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
  requiredHostMethodVersion: {
    method: "providers.awaitLogin",
    version: { major: 2, minor: 1 },
  },
  signal: null,
};

/**
 * The start and its cancel both carry this command's holder id, so a Ctrl+C
 * here releases this command's claim and cannot end a sign-in the GUI started
 * for the same profile. Holder ids arrived with `startLogin@1.4` and
 * `cancelLogin@1.2`; below either the field is stripped and the cancel widens
 * to everyone's login, so both calls name their floor.
 */
const START_LOGIN_RESPONSE_TIMEOUT_MS = 30_000;
const START_LOGIN_DISPATCH: HostRpcDispatch = {
  // The host holds this call while the login child comes up, for up to 25s
  // of the 30s it assumes a client waits, before it answers "still starting".
  // The transport's 15s default would abandon a start the host was about to
  // answer.
  responseTimeoutMs: START_LOGIN_RESPONSE_TIMEOUT_MS,
  requiredHostMethodVersion: {
    method: "providers.startLogin",
    version: { major: 1, minor: 4 },
  },
  signal: null,
};
const CANCEL_LOGIN_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.cancelLogin",
    version: { major: 1, minor: 2 },
  },
  signal: null,
};
/** Gap between two asks while the provider's pack downloads. */
const PACK_POLL_MS = 2_000;
/** How often the host may answer "still starting" before this side gives up. */
const STILL_STARTING_CAP = 12;
/** Under the host's 3-minute rolling deadline for a paste-code sign-in. */
const KEEPALIVE_INTERVAL_MS = 60_000;
/**
 * The ambient verdict can still be in flight when the long-poll settles; the
 * host says so with `authPending`, and asking again is cheap.
 */
const AUTH_PENDING_REPOLL_CAP = 3;
const AUTH_PENDING_REPOLL_DELAY_MS = 2_000;

const INTERRUPTED_EXIT_CODE = 130;

type LoginOutcome =
  | {
      readonly status: "signed-in";
      readonly profile: ProfileListRow | null;
      readonly created: boolean;
    }
  | { readonly status: "already-exists"; readonly profile: ProfileListRow }
  | { readonly status: "refused"; readonly refusal: ProviderLoginRefusal }
  | { readonly status: "code-rejected" }
  | { readonly status: "not-completed" }
  | { readonly status: "not-started"; readonly message: string }
  | { readonly status: "cancelled" };

/**
 * `traycer profile add <provider>` and `traycer profile login <provider>
 * <profile>` - the host's headless sign-in, driven from a terminal: ask the
 * host to start it, print the link (and code) it hands back, then wait for the
 * host to say how it ended.
 *
 * The host owns the profile's lifecycle throughout. It refuses a create for a
 * provider without managed profiles, discards a profile whose sign-in is
 * cancelled or fails, and discards one whose account turns out to belong to
 * an existing profile - so nothing here cleans up beyond releasing its own
 * claim on Ctrl+C.
 */
export function buildProfileLoginCommand(
  opts: { readonly provider: string; readonly target: ProfileLoginTarget },
  io: ProfileLoginIo,
): CommandFn {
  return async (ctx) => {
    const providerId = parseProviderArgument(opts.provider);
    const target = resolveTarget(opts.target);
    assertPersonPresent(ctx);
    const state = await readProviderState(providerId);
    assertCanTakeCode(io, state);
    if (
      target.profileId !== null &&
      !state.profiles.some((p) => p.profileId === target.profileId)
    ) {
      throw cliError({
        code: CLI_ERROR_CODES.NOT_FOUND,
        message: `traycer: ${describeProvider(providerId)} has no profile '${printable(target.profileId)}' - run 'traycer profile list ${printable(opts.provider)}' to see them.`,
        details: null,
        exitCode: 1,
      });
    }
    const outcome = await runLogin(ctx, io, providerId, target, state);
    return resultOf(providerId, outcome);
  };
}

interface ResolvedTarget {
  readonly create: { readonly label: string | null } | null;
  /** The existing row to sign in; null for a create and for ambient. */
  readonly profileId: string | null;
}

function resolveTarget(target: ProfileLoginTarget): ResolvedTarget {
  if (target.kind === "create") {
    return {
      create: {
        label: target.label === null ? null : parseProfileLabel(target.label),
      },
      profileId: null,
    };
  }
  const profileId = parseProfileArgument(target.profile);
  // The login methods address ambient as "no profile override", not by the
  // row sentinel the profile mutations take.
  return {
    create: null,
    profileId: isAmbientProfileId(profileId) ? null : profileId,
  };
}

/**
 * A sign-in needs a person: someone has to open the link. `--json` and CI
 * have nobody, whatever the provider, so they are refused before the host is
 * asked anything - the refusal then reads the same whether or not a host is
 * running.
 */
function assertPersonPresent(ctx: CommandContext): void {
  if (!ctx.runtime.json && !ctx.runtime.nonInteractive) return;
  throw notInteractive();
}

/**
 * A paste-code provider also needs a stdin the person can type the code into.
 * With stdin redirected the code could never be submitted and the command
 * would wait out the host's whole deadline, so it is refused before the host
 * is asked to start anything. A device-code sign-in reads nothing from stdin
 * and works without one, which is why this waits for the provider's
 * capability instead of joining the check above.
 */
function assertCanTakeCode(io: ProfileLoginIo, state: ProviderCliState): void {
  if (!declares(state.loginCapability?.codePaste) || io.stdinIsTerminal()) {
    return;
  }
  throw notInteractive();
}

function notInteractive(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message:
      "traycer: signing a profile in needs a person at a terminal - run this in an interactive terminal, without --json and outside CI.",
    details: null,
    exitCode: 1,
  });
}

async function readProviderState(
  providerId: ProviderId,
): Promise<ProviderCliState> {
  const response = await toAgentCliError(
    callHostRpc("providers.list", { native: null }),
  );
  const state = response.providers.find((p) => p.providerId === providerId);
  if (state === undefined) {
    throw cliError({
      code: CLI_ERROR_CODES.NOT_FOUND,
      message: `traycer: this host does not know the provider ${describeProvider(providerId)}.`,
      details: null,
      exitCode: 1,
    });
  }
  return state;
}

async function runLogin(
  ctx: CommandContext,
  io: ProfileLoginIo,
  providerId: ProviderId,
  target: ResolvedTarget,
  state: ProviderCliState,
): Promise<LoginOutcome> {
  const holderId = io.newHolderId();
  const abort = new AbortController();
  const interrupt = (): void => abort.abort();
  const stopListening = io.onInterrupt(interrupt);
  // The profile a login on the host is held under: the caller's own for an
  // existing row, the host-minted one for a create once an answer names it.
  let heldProfileId = target.profileId;
  const release = async (): Promise<void> => {
    await callHostRpcWithDispatch(
      "providers.cancelLogin",
      { providerId, profileId: heldProfileId, holderId },
      CANCEL_LOGIN_DISPATCH,
    ).catch(() => undefined);
  };
  try {
    const answer = await startUntilSettled(
      ctx,
      io,
      {
        providerId,
        holderId,
        profileId: target.profileId,
        createProfile:
          target.create === null
            ? null
            : {
                label: target.create.label ?? "",
                shareSkillsAndPlugins: false,
              },
      },
      abort.signal,
      // Each answer, not only the last: a create's "still starting" answer
      // already names the profile the host minted, so a release after a
      // thrown ask names it too. The host finds this command's login by its
      // holder id; naming the profile keeps the release right for a host
      // that keys the cancel by profile.
      (received) => {
        if (target.create !== null) heldProfileId = received.profileId;
      },
    );
    const holdsLogin = answer.started || answer.pending === "starting";
    if (abort.signal.aborted) {
      if (holdsLogin) await release();
      return { status: "cancelled" };
    }
    const notStarted = notStartedMessage(
      answer,
      target.create !== null && heldProfileId === null,
    );
    if (notStarted !== null) {
      if (holdsLogin) await release();
      return { status: "not-started", message: notStarted };
    }
    const acceptsPastedCode = declares(state.loginCapability?.codePaste);
    const stopPaste = acceptsPastedCode
      ? acceptPastedCode(ctx, io, providerId, heldProfileId, interrupt)
      : null;
    announce(ctx, io, state, answer, stopPaste !== null);
    const keepalive = !acceptsPastedCode
      ? null
      : setInterval(() => {
          void callHostRpc("providers.touchLogin", {
            providerId,
            profileId: heldProfileId,
          }).catch(() => undefined);
        }, KEEPALIVE_INTERVAL_MS);
    try {
      const result = await awaitUntilSettled(
        io,
        providerId,
        heldProfileId,
        abort.signal,
      );
      if (result === null) {
        await release();
        return { status: "cancelled" };
      }
      return await outcomeOf(providerId, target, heldProfileId, result);
    } finally {
      if (keepalive !== null) clearInterval(keepalive);
      stopPaste?.();
    }
  } catch (error) {
    // A call failed partway: the start timed out after the host had begun
    // it, the host went away mid-wait, or Ctrl+C aborted a start that was
    // still in flight - whose answer, and any login it reports, this command
    // will now never see. Nobody is waiting for this login any more, so give
    // up the claim on it rather than leave it for the host's own deadline.
    // The host remembers a released holder, so a start still on its way in
    // finds the claim gone and spawns nothing.
    //
    // Read before the release, which is itself a call that can take a while:
    // a Ctrl+C pressed during it must not turn a real error into "cancelled".
    const interrupted = abort.signal.aborted;
    await release();
    if (interrupted) return { status: "cancelled" };
    throw error;
  } finally {
    stopListening();
  }
}

/**
 * Asks the host to start the sign-in until its answer is final. A host still
 * fetching the provider's pack, or whose login child has not printed its link
 * yet, answers `pending`, and the same request asked again attaches to that
 * work rather than starting another. A provider setup that had failed is asked
 * to retry once before the answer is taken as final.
 */
async function startUntilSettled(
  ctx: CommandContext,
  io: ProfileLoginIo,
  request: StartLoginRequest,
  signal: AbortSignal,
  onAnswer: (answer: StartLoginAnswer) => void,
): Promise<StartLoginAnswer> {
  let stillStarting = 0;
  let packRetried = false;
  for (;;) {
    const answer = await toAgentCliError(
      callHostRpcWithDispatch(
        "providers.startLogin",
        request,
        // The host can hold this call for most of its response budget, so
        // Ctrl+C aborts it instead of waiting for the answer.
        { ...START_LOGIN_DISPATCH, signal },
      ),
    );
    onAnswer(answer);
    if (
      answer.pending === null &&
      !answer.started &&
      (answer.pack?.reason ?? null) !== null &&
      !packRetried &&
      !signal.aborted
    ) {
      // The provider's setup failed earlier, and asking for the sign-in
      // again would return the same cached failure until the host next
      // retries by itself, if it does. `providers.ensurePack` is how a person
      // asks for a retry now, and one is present: this command refuses to run
      // without one. Once, and best effort: a failure no retry can move is
      // refused by the host, and the next answer reports the pack either way.
      packRetried = true;
      await callHostRpc("providers.ensurePack", {
        providerId: request.providerId,
      }).catch(() => undefined);
      continue;
    }
    if (answer.pending === null || signal.aborted) return answer;
    if (answer.pending === "starting") {
      stillStarting += 1;
      if (stillStarting >= STILL_STARTING_CAP) return answer;
      continue;
    }
    stillStarting = 0;
    ctx.progress({
      stage: "provider-setup",
      message: "Downloading the provider's first-time setup",
      percent: answer.pack?.percent ?? null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    await io.wait(PACK_POLL_MS);
    if (signal.aborted) return answer;
  }
}

const NOT_STARTED = "The sign-in did not start.";

/** Why a final answer is not a started sign-in, or null when it is one. */
function notStartedMessage(
  answer: StartLoginAnswer,
  profileMissing: boolean,
): string | null {
  if (answer.failure === "device_auth_unavailable") {
    return "Device-code login is not enabled for this ChatGPT account. Enable it in ChatGPT security settings (personal) or workspace permissions (admin), then retry.";
  }
  if (answer.failure === "device_code_missing") {
    return "Sign-in did not print a device code in time. Try again.";
  }
  if (answer.started && !profileMissing) return null;
  if (answer.pending === "starting") {
    return "The provider took too long to start its sign-in. Try again.";
  }
  if (answer.pack !== null && answer.pack.reason !== null) {
    return `The provider's first-time setup did not install (${printable(answer.pack.reason)}). Try again.`;
  }
  return NOT_STARTED;
}

/** A login capability marker is an object when declared, null or absent when not. */
function declares(marker: object | null | undefined): boolean {
  return marker !== null && marker !== undefined;
}

/**
 * The http(s) URL `value` parses to, or null. The parsed form is what gets
 * both printed and opened: the parser drops tabs and line breaks, so the raw
 * string could print as one link and open as another.
 */
function httpUrlOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function announce(
  ctx: CommandContext,
  io: ProfileLoginIo,
  state: ProviderCliState,
  answer: StartLoginAnswer,
  readingPastedCode: boolean,
): void {
  // The link is the host's relay of what a provider CLI printed. Only an
  // http(s) one is shown as a link to open or handed to the OS opener.
  const url = answer.url === null ? null : httpUrlOf(answer.url);
  const lines: string[] = [];
  if (url !== null) {
    lines.push(
      "To sign in, open this URL in a browser:",
      `  ${printable(url)}`,
    );
  } else {
    lines.push("Finish the sign-in in the browser window the provider opened.");
  }
  if (answer.userCode !== null) {
    lines.push("and enter the code:", `  ${printable(answer.userCode)}`);
  }
  if (readingPastedCode) {
    lines.push(
      "",
      "If the browser shows a code instead of finishing, paste it here and press Enter.",
    );
  }
  lines.push("", "Waiting for the sign-in to finish (Ctrl+C to cancel)...");
  ctx.output.humanRequired(lines.join("\n"));
  // A provider that opens its own page already has; a second tab over it is
  // the double-open the capability marker exists to prevent.
  if (url !== null && !declares(state.loginCapability?.selfOpensBrowser)) {
    io.openUrl(url);
  }
}

function acceptPastedCode(
  ctx: CommandContext,
  io: ProfileLoginIo,
  providerId: ProviderId,
  profileId: string | null,
  interrupt: () => void,
): (() => void) | null {
  return io.readLines((line) => {
    const code = line.trim();
    if (code.length === 0) return;
    void callHostRpc("providers.submitLoginCode", {
      providerId,
      profileId,
      code,
    }).then(
      (response) => {
        ctx.output.humanRequired(
          response.outcome === "accepted"
            ? "Code sent. Checking it..."
            : "That sign-in is no longer running. Run the command again.",
        );
      },
      () => {
        ctx.output.humanRequired("Could not send the code. Paste it again.");
      },
    );
  }, interrupt);
}

/**
 * Waits for the host to say how the sign-in ended. Null when the wait was
 * interrupted. An ambient verdict the host reports as still in flight is
 * asked for again a few times rather than read as a failure.
 */
async function awaitUntilSettled(
  io: ProfileLoginIo,
  providerId: ProviderId,
  profileId: string | null,
  signal: AbortSignal,
): Promise<AwaitLoginResult | null> {
  for (let repolls = 0; ; repolls += 1) {
    let result: AwaitLoginResult;
    try {
      result = await toAgentCliError(
        callHostRpcWithDispatch(
          "providers.awaitLogin",
          { providerId, profileId },
          { ...AWAIT_LOGIN_DISPATCH, signal },
        ),
      );
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    }
    if (signal.aborted) return null;
    const pending =
      profileId === null &&
      !result.codeRejected &&
      result.state !== null &&
      result.state.authPending &&
      result.state.auth.status !== "authenticated" &&
      result.state.auth.status !== "unauthenticated";
    if (!pending || repolls >= AUTH_PENDING_REPOLL_CAP) return result;
    await io.wait(AUTH_PENDING_REPOLL_DELAY_MS);
    if (signal.aborted) return null;
  }
}

async function outcomeOf(
  providerId: ProviderId,
  target: ResolvedTarget,
  heldProfileId: string | null,
  result: AwaitLoginResult,
): Promise<LoginOutcome> {
  if (result.refusal !== null) {
    return { status: "refused", refusal: result.refusal };
  }
  const echoed = (result.state?.profiles ?? []).map(summarizeProfile);
  if (result.existingProfileId !== null) {
    const existing = await findProfileRow(
      providerId,
      echoed,
      result.existingProfileId,
    );
    if (existing !== null)
      return { status: "already-exists", profile: existing };
  }
  // Presence is not success: a row stays listed while signed out, so the row
  // (or, for ambient, the provider's own verdict) must say authenticated.
  if (heldProfileId === null) {
    return result.state?.auth.status === "authenticated"
      ? { status: "signed-in", profile: null, created: false }
      : failedOutcome(result);
  }
  // A null state is the host saying the sign-in did not complete. The row is
  // not looked up elsewhere then: a profile that was already signed in would
  // still list as authenticated and read as this sign-in's success.
  if (result.state === null) return failedOutcome(result);
  const row = await findProfileRow(providerId, echoed, heldProfileId);
  if (row === null || row.authStatus !== "authenticated") {
    return failedOutcome(result);
  }
  if (target.create === null) {
    return { status: "signed-in", profile: row, created: false };
  }
  return {
    status: "signed-in",
    profile: await nameNewProfile(providerId, row, target.create.label),
    created: true,
  };
}

/**
 * The row for `profileId`, from the sign-in's own echo when it is there. The
 * echo leaves out a profile that is switched off, so a disabled profile that
 * just signed in (or already holds the account) is read from `providers.list`,
 * which lists every row. Null when neither has it.
 */
async function findProfileRow(
  providerId: ProviderId,
  echoed: readonly ProfileListRow[],
  profileId: string,
): Promise<ProfileListRow | null> {
  const fromEcho = echoed.find((row) => row.profileId === profileId);
  if (fromEcho !== undefined) return fromEcho;
  try {
    const state = await readProviderState(providerId);
    const listed = state.profiles.find((p) => p.profileId === profileId);
    return listed === undefined ? null : summarizeProfile(listed);
  } catch {
    return null;
  }
}

function failedOutcome(result: AwaitLoginResult): LoginOutcome {
  return result.codeRejected
    ? { status: "code-rejected" }
    : { status: "not-completed" };
}

/**
 * A profile created without `--label` takes the account's email prefix, the
 * GUI's default. Best effort: the profile is signed in either way, and
 * `traycer profile rename` is there if this did not land.
 */
async function nameNewProfile(
  providerId: ProviderId,
  profile: ProfileListRow,
  requestedLabel: string | null,
): Promise<ProfileListRow> {
  if (requestedLabel !== null) return profile;
  const label = (profile.email?.split("@")[0] ?? "").trim().slice(0, 64);
  if (label.length === 0 || label === profile.label) return profile;
  try {
    await callHostRpcWithDispatch(
      "providers.setEnabled",
      {
        providerId,
        enabled: true,
        profileAction: { type: "rename", profileId: profile.profileId, label },
      },
      {
        ...PLAIN_DISPATCH,
        requiredHostMethodVersion: {
          method: "providers.setEnabled",
          version: { major: 2, minor: 1 },
        },
      },
    );
    return { ...profile, label };
  } catch {
    return profile;
  }
}

function describeRow(row: ProfileListRow): string {
  return `${printable(row.profileId)} "${printable(row.label)}"`;
}

function resultOf(
  providerId: ProviderId,
  outcome: LoginOutcome,
): CommandResult {
  const provider = describeProvider(providerId);
  const data = { providerId, ...outcome };
  switch (outcome.status) {
    case "signed-in":
      return {
        data,
        human:
          outcome.profile === null
            ? `Signed in to ${provider}.`
            : `${outcome.created ? "Added" : "Signed in"} ${provider} profile ${describeRow(outcome.profile)}${outcome.profile.email === null ? "" : ` (${printable(outcome.profile.email)})`}.`,
        exitCode: 0,
      };
    case "already-exists":
      return {
        data,
        human: `That account is already ${provider} profile ${describeRow(outcome.profile)}. No profile was added.`,
        exitCode: 0,
      };
    case "refused":
      return {
        data,
        human: `${provider} refused the sign-in: ${printable(outcome.refusal.reason)}${outcome.refusal.actionUrl === null ? "" : `\n  ${printable(outcome.refusal.actionUrl)}`}`,
        exitCode: 1,
      };
    case "code-rejected":
      return {
        data,
        human: "That code was rejected. Run the command again for a new link.",
        exitCode: 1,
      };
    case "not-completed":
      return { data, human: "The sign-in did not complete.", exitCode: 1 };
    case "not-started":
      return { data, human: outcome.message, exitCode: 1 };
    case "cancelled":
      return {
        data,
        human: "Sign-in cancelled.",
        exitCode: INTERRUPTED_EXIT_CODE,
      };
  }
}
