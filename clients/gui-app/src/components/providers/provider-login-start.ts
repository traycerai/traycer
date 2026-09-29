import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import {
  providerPackPreparingLabel,
  providerPackRetryable,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { providerStartLoginFailureMessage } from "@/components/providers/provider-signin-availability";

export type ProviderStartLoginRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;
export type ProviderStartLoginAnswer = ResponseOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;

/**
 * What the host is doing while a sign-in has been asked for and its page is
 * not ready yet.
 *
 * `opening` is the first call, before the host has said anything. The other
 * two are the host's own words (`pending` on the answer): `launching` is a
 * login child that is running and has not printed its link, `downloading` is
 * a provider whose managed pack is still on its way.
 */
export type ProviderLoginStartProgress =
  | { readonly kind: "opening" }
  | { readonly kind: "launching" }
  | { readonly kind: "downloading"; readonly percent: number | null };

export interface ProviderLoginStartCopy {
  readonly title: string;
  readonly guidance: string;
}

/**
 * Gap between two questions while the pack downloads. The host answers that
 * one at once, so without a gap the wait would be a busy loop; two seconds
 * keeps the percentage moving without asking more often than it changes.
 */
export const PROVIDER_LOGIN_PACK_POLL_MS = 2_000;

/**
 * How many times in a row the host may answer "still starting" before this
 * side stops asking. The host ends a child that has not produced its link
 * after two minutes, and each answer takes a whole call to arrive, so a
 * healthy host never gets near this; it exists so a broken one cannot hold a
 * dialog on a spinner for ever.
 */
export const PROVIDER_LOGIN_STILL_STARTING_CAP = 12;

/**
 * The copy for a start that is taking longer than "a moment", or null while
 * the ordinary "Opening the sign-in page…" still describes it.
 */
export function providerLoginStartCopy(
  progress: ProviderLoginStartProgress,
  providerId: ProviderId,
): ProviderLoginStartCopy | null {
  const providerLabel = PROVIDER_DISPLAY_NAMES[providerId];
  if (progress.kind === "launching") {
    return {
      title: `Starting ${providerLabel}…`,
      guidance:
        "This can take up to a minute. The sign-in page opens as soon as it is ready.",
    };
  }
  if (progress.kind === "downloading") {
    return {
      title: providerPackPreparingLabel(
        {
          kind: "downloading",
          percent: progress.percent,
          retryAtMs: null,
          reason: null,
          // The host had nothing to spawn, or it would have spawned it.
          fallbackRunnable: false,
        },
        providerLabel,
      ),
      guidance:
        "First-time setup is downloading. Sign-in continues on its own when it finishes.",
    };
  }
  return null;
}

/**
 * The failed install behind an answer, when the provider's pack is why the
 * sign-in did not start. Null for every other outcome, a download that is
 * still running included.
 */
export function providerLoginPackFailure(
  answer: ProviderStartLoginAnswer,
): ProviderPackPreparing | null {
  const pack = answer.pack ?? null;
  if (pack === null || pack.reason === null) return null;
  return {
    kind: "error",
    percent: null,
    retryAtMs: pack.retryAtMs,
    reason: pack.reason,
    fallbackRunnable: false,
  };
}

/**
 * Whether the next press should ask the host to fetch the pack again before
 * it asks for the sign-in. Only for a failure a retry can move: for the rest
 * the host refuses the request, and the press would be offered-then-failed.
 */
export function providerLoginAnswerWantsPackRetry(
  answer: ProviderStartLoginAnswer | null,
): boolean {
  if (answer === null) return false;
  const failure = providerLoginPackFailure(answer);
  return failure !== null && providerPackRetryable(failure);
}

/**
 * What to tell the user about a sign-in the host did not start: the typed
 * failure when there is one, the pack's own failure when the pack is the
 * reason, and the surface's generic sentence otherwise.
 */
export function providerLoginNotStartedMessage(
  answer: ProviderStartLoginAnswer,
  providerId: ProviderId,
  notStarted: string,
): string {
  const failure = answer.failure ?? null;
  if (failure !== null) {
    return providerStartLoginFailureMessage(failure, notStarted);
  }
  const packFailure = providerLoginPackFailure(answer);
  if (packFailure !== null) {
    return providerPackPreparingLabel(
      packFailure,
      PROVIDER_DISPLAY_NAMES[providerId],
    );
  }
  return notStarted;
}

/**
 * Whether the answer that ENDED a press leaves a login child on the host that
 * nobody is coming back for.
 *
 * `pending: "starting"` on that answer means this side stopped asking - the
 * user cancelled or moved on, or the host said "still starting" too often -
 * not that the host gave up: it keeps the child alive for the next call to
 * attach to. The GUI is the only side that opens that child's consent page,
 * so once nobody is asking, nothing ever will, and the child only waits for
 * the host to reap it. Whoever stops asking releases it with
 * `providers.cancelLogin`.
 */
export function providerLoginAnswerStillStarting(
  answer: ProviderStartLoginAnswer,
): boolean {
  return (answer.pending ?? null) === "starting";
}

/**
 * Whether the answer holds a login nobody will use once the surface that
 * asked for it is gone: one still starting (above), or one that started for
 * a provider that does not open its own page (`selfOpensBrowser` null), so
 * the GUI that just went away was the only thing that would have. Antigravity
 * is one: the host switches the server's own browser open off and relies on
 * the GUI to open the link.
 *
 * A provider that opens its own page is left alone, on a remote host too.
 * That page may already be open in a browser on the host's machine, where
 * the user can still finish the sign-in.
 */
export function providerLoginAnswerHeldForNobody(
  answer: ProviderStartLoginAnswer,
  loginCapability: ProviderCliState["loginCapability"],
): boolean {
  if (providerLoginAnswerStillStarting(answer)) return true;
  return answer.started && (loginCapability?.selfOpensBrowser ?? null) === null;
}

function progressOfAnswer(
  answer: ProviderStartLoginAnswer,
): ProviderLoginStartProgress | null {
  const pending = answer.pending ?? null;
  if (pending === "starting") return { kind: "launching" };
  if (pending === "pack_preparing") {
    return { kind: "downloading", percent: answer.pack?.percent ?? null };
  }
  return null;
}

export interface StartProviderLoginInput {
  readonly request: ProviderStartLoginRequest;
  readonly startLogin: (
    request: ProviderStartLoginRequest,
  ) => Promise<ProviderStartLoginAnswer>;
  /**
   * Asks the host to fetch the provider's pack again. Called once, before the
   * first question, and only when `retryPackFirst` says the press follows a
   * failed install. Its outcome is not read: the sign-in's own answer reports
   * the pack either way.
   */
  readonly ensurePack: () => Promise<unknown>;
  readonly retryPackFirst: boolean;
  /**
   * Called with each answer that is not final, before the next question.
   * `answer.profileId` is the target the host is holding a login for when
   * the progress is `launching`.
   */
  readonly onProgress: (
    progress: ProviderLoginStartProgress,
    answer: ProviderStartLoginAnswer,
  ) => void;
  /** True once nobody wants the answer: cancelled, superseded, unmounted. */
  readonly shouldStop: () => boolean;
  readonly wait: (ms: number) => Promise<void>;
}

/**
 * Asks the host to start a sign-in and keeps asking until the answer is
 * final.
 *
 * One call is no longer always enough. A host that is still fetching the
 * provider's pack, or whose login child needs longer to come up than a call
 * may take, answers `pending` and means it: the same question, asked again,
 * attaches to the work already under way. A caller that stopped at the first
 * answer showed "Sign-in did not start" for a sign-in that was starting.
 *
 * Resolves with the first answer that carries no `pending`, or with the
 * latest answer once `shouldStop` reports nobody is waiting or the host has
 * said "still starting" too many times. The caller reads that answer exactly
 * as it read a single call's: a non-null `pending` on it means this side gave
 * up, and is rendered as not started. A `starting` one also leaves a login
 * child for the caller to release (`providerLoginAnswerStillStarting`).
 */
export async function startProviderLoginUntilSettled(
  input: StartProviderLoginInput,
): Promise<ProviderStartLoginAnswer> {
  if (input.retryPackFirst) {
    await input.ensurePack().catch(() => undefined);
  }
  let stillStarting = 0;
  for (;;) {
    const answer = await input.startLogin(input.request);
    const progress = progressOfAnswer(answer);
    if (progress === null || input.shouldStop()) return answer;
    if (progress.kind === "launching") {
      stillStarting += 1;
      if (stillStarting >= PROVIDER_LOGIN_STILL_STARTING_CAP) return answer;
    } else {
      stillStarting = 0;
    }
    input.onProgress(progress, answer);
    if (progress.kind === "downloading") {
      await input.wait(PROVIDER_LOGIN_PACK_POLL_MS);
      if (input.shouldStop()) return answer;
    }
  }
}

export function waitForProviderLoginStart(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
