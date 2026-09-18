import {
  type ProviderCliState,
  type ProviderId,
  type ProvidersAwaitLoginResponse,
} from "@traycer/protocol/host/provider-schemas";
import { Check, Copy, ExternalLink, Info } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { OnboardingProviderDiscovery } from "@/components/onboarding/onboarding-provider-discovery";
import { OnboardingProviderGrid } from "@/components/onboarding/onboarding-provider-grid";
import type { ProviderListRow } from "@/components/providers/provider-list";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  providerSignInUnavailableHint,
  providerStartLoginFailureMessage,
  providerSupportsTerminalLogin,
} from "@/components/providers/provider-signin-availability";
import { CodePasteField } from "@/components/settings/panels/code-paste-field";
import { handleSignInLinkCopyError } from "@/components/settings/panels/provider-sign-in-link";
import type { ProviderProfileLoginFlowCodePaste } from "@/components/settings/panels/use-provider-profile-login-flow";
import {
  openBrowserLabel,
  useAutoOpenLoginUrl,
} from "@/components/settings/panels/use-auto-open-login-url";
import { waitingStepCopy } from "@/components/settings/panels/waiting-step-copy";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import { useProvidersStartLogin } from "@/hooks/providers/use-providers-start-login-mutation";
import { useHostScopedProvidersAwaitLogin } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersSubmitLoginCode } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLogin } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useOpenLink } from "@/lib/links/open-link";
import {
  AMBIENT_AUTH_PENDING_REPOLL_CAP,
  AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS,
  isAmbientAuthVerdictPending,
  isProviderAmbientAuthenticated,
} from "@/lib/providers/provider-ambient-auth";
import {
  orderProvidersByEnablement,
  type OrderedProvider,
} from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import "./onboarding-agents.css";
type InstallState = "detected" | "missing" | "pending";

function installStateFor(state: ProviderCliState | undefined): InstallState {
  if (state === undefined) return "pending";
  if (state.candidates.some((candidate) => candidate.available)) {
    return "detected";
  }
  if (state.candidates.some((candidate) => candidate.versionPending)) {
    return "pending";
  }
  return "missing";
}

const INSTALL_LABELS: Record<InstallState, string> = {
  detected: "Installed",
  missing: "Not installed",
  pending: "Detecting…",
};

interface AccountLine {
  readonly text: string;
  readonly tone: "good" | "muted";
  readonly title: string | null;
}

const TERMINAL_LOGIN_DISABLED_SUBTEXT =
  "Turn it on now. The first time you pick it, the model picker will walk you through its terminal setup.";

/**
 * Every word a PHONE row's second line can carry, in one table.
 *
 * One table rather than a second `accountLineFor`, because a phone row's line
 * is a different kind of thing: 13pt, one line, no tooltip, no dot, and it
 * shares the line with the discovery counts. The card's own copy is unchanged -
 * it has two lines and a hover affordance to spend on a sentence, and the
 * sentence above is the one this list cannot take (measured: it truncated to
 * "Turn it on now. The first time y…" on a 393pt screen, which is a status the
 * user cannot read and cannot open).
 *
 * The keys are the STATES, not the providers, so the copy review has one place
 * to read and change. Add a state here before you add a branch below.
 */
const PHONE_STATUS = {
  unreachable: "Unavailable",
  missing: "Not installed",
  pending: "Checking…",
  traycerOn: "Ready to use",
  traycerOff: "Included in your plan",
  terminalLoginOff: "Turn on, set up later",
  authenticated: "Signed in",
  configured: "Set up, unverified",
  statusUnavailable: "Couldn’t check status",
  apiKey: "API key added",
  unauthenticated: "Sign in to use",
  unknown: "Status unknown",
} as const;

/**
 * Which of those words this row gets.
 *
 * The ladder is `accountLineFor`'s, in the same order and for the same reasons
 * - including the terminal-login branch sitting ABOVE the auth ladder, which is
 * what stops a disabled terminal-login provider landing on a status whose
 * remedy cannot be performed anywhere on this screen. What differs is only the
 * words, and the two install states the card spells in a separate slot.
 */
function phoneStatusFor(input: {
  readonly state: ProviderCliState | undefined;
  readonly installDetected: boolean;
  readonly installState: InstallState;
  readonly hostUnavailable: boolean;
}): string {
  const { state, installDetected, installState, hostUnavailable } = input;
  if (hostUnavailable) return PHONE_STATUS.unreachable;
  if (state === undefined || !installDetected)
    return installState === "pending"
      ? PHONE_STATUS.pending
      : PHONE_STATUS.missing;
  if (state.providerId === "traycer")
    return state.enabled ? PHONE_STATUS.traycerOn : PHONE_STATUS.traycerOff;
  if (state.authPending) return PHONE_STATUS.pending;
  if (
    !state.enabled &&
    providerSupportsTerminalLogin(state.loginCapability) &&
    !isProviderAmbientAuthenticated(state)
  )
    return PHONE_STATUS.terminalLoginOff;
  const { auth } = state;
  if (auth.status === "authenticated") return PHONE_STATUS.authenticated;
  if (auth.status === "configured") return PHONE_STATUS.configured;
  if (auth.status === "unavailable") return PHONE_STATUS.statusUnavailable;
  if (state.apiKey.configured) return PHONE_STATUS.apiKey;
  if (auth.status === "unauthenticated") return PHONE_STATUS.unauthenticated;
  return PHONE_STATUS.unknown;
}

/** Mirrors `ProviderAuthLine`, restyled for the cinematic copy column. */
function accountLineFor(state: ProviderCliState): AccountLine {
  if (state.providerId === "traycer") {
    return {
      text: state.enabled
        ? "Ready with your Traycer subscription"
        : "Available with your Traycer subscription",
      tone: "good",
      title: null,
    };
  }
  const { auth } = state;
  if (state.authPending) {
    return { text: "Checking account…", tone: "muted", title: null };
  }
  // A terminal-login provider's row carries no sign-in affordance here (see
  // `providerNeedsSignInToEnable`), so without this the row's only word about
  // it would be a status whose remedy cannot be performed on this screen. Say
  // what the gesture is instead.
  //
  // REBASED onto the tours/Getting-started redesign (#1974), which removed this
  // function's `!state.enabled` early return - the account line is now purely
  // about the ACCOUNT and a disabled provider falls through to the ladder
  // below. That moved the defect rather than fixing it: a disabled,
  // terminal-login, signed-out row now lands on "Not signed in", which is the
  // same dead status one branch further down. Hence the enabled check survives
  // here, above the ladder, instead of gating the whole function.
  //
  // PROVIDER-AGNOSTIC and deliberately not the word "sign in": this class spans
  // providers whose terminal flow is not an account sign-in at all (Hermes asks
  // for an inference provider and its API key), so promising one would be false
  // for them. Nothing "asks", either - the picker offers a setup card with a
  // button.
  //
  // THREE conditions, and DO NOT unify them with the mount guard's. They answer
  // different questions that merely agree on most rows. The guard asks "can a
  // sign-in be performed on this screen" - no, for the whole class, whatever
  // the account says. This asks "what should THIS user do next", and the answer
  // genuinely differs: an authenticated account gets no setup walkthrough from
  // the picker, because there is nothing left to set up, so the sentence would
  // describe something that will not happen. Collapsing the two because they
  // coincide today is how `--device-auth` came to encode three properties as
  // one string match.
  //
  // Reading the auth verdict is safe HERE and nowhere near the guard: this is
  // display only. The prohibition on `providerNeedsSignInToEnable` is about
  // MOUNTING, where a verdict that flips mid-attempt deletes the row and
  // strands the enable.
  if (
    !state.enabled &&
    providerSupportsTerminalLogin(state.loginCapability) &&
    !isProviderAmbientAuthenticated(state)
  ) {
    return {
      text: TERMINAL_LOGIN_DISABLED_SUBTEXT,
      tone: "muted",
      title: null,
    };
  }
  if (auth.status === "authenticated") {
    return {
      text: "Signed in",
      tone: "good",
      title: [auth.label, auth.detail].filter(Boolean).join(" · ") || null,
    };
  }
  if (auth.status === "configured") {
    return {
      text: "Configured, not verified",
      tone: "muted",
      title: auth.detail,
    };
  }
  if (auth.status === "unavailable") {
    return {
      text: "Status check failed",
      tone: "muted",
      title: auth.detail,
    };
  }
  if (state.apiKey.configured) {
    return { text: "API key set", tone: "good", title: null };
  }
  if (auth.status === "unauthenticated") {
    return { text: "Not signed in", tone: "muted", title: null };
  }
  return { text: "Account status unavailable", tone: "muted", title: null };
}

function installLabelFor(
  traycerProvider: boolean,
  hostUnavailable: boolean,
  installState: InstallState,
): string {
  if (traycerProvider) return "Built in";
  if (hostUnavailable) return "Unavailable";
  return INSTALL_LABELS[installState];
}

function providerStateFor(
  providers: readonly ProviderCliState[] | undefined,
  providerId: ProviderId,
): ProviderCliState | undefined {
  return providers?.find((provider) => provider.providerId === providerId);
}

function enabledForProvider(state: ProviderCliState | undefined): boolean {
  return state?.enabled ?? false;
}

function disablingLastEnabledFor(
  state: ProviderCliState | undefined,
  enabled: boolean,
  enabledProviderCount: number,
): boolean {
  if (state === undefined) return false;
  return enabled && enabledProviderCount <= 1;
}

/**
 * The card's one status line: a dot and a sentence.
 *
 * Install and account used to be two separate slots - a right-aligned install
 * badge plus an account caption - which made every card carry two pieces of
 * grey micro-copy that said the same thing twice for the two states that
 * matter. A card the machine does not have says only that; a card it does have
 * says what the ACCOUNT is, because that is the only thing left to decide.
 */
function providerStatusLine(
  state: ProviderCliState | undefined,
  installDetected: boolean,
  installLabel: string,
  /** Why this card offers no sign-in, or null when it needs no excuse. */
  signInHint: string | null,
): ReactNode {
  const account =
    state !== undefined && installDetected ? accountLineFor(state) : null;
  const text = account?.text ?? installLabel;
  const tone = account?.tone ?? "muted";
  return (
    <TooltipWrapper
      // The sign-in refusal outranks the account detail: it is the reason the
      // card's expected affordance is missing, and the detail is a nicety.
      label={signInHint ?? account?.title ?? undefined}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "good" ? "bg-success" : "bg-foreground/30",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate",
            tone === "good" ? "text-foreground/85" : "text-muted-foreground",
          )}
        >
          {text}
        </span>
        {signInHint !== null ? (
          <>
            <Info
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            {/* The sentence itself stays in the accessible name - a tooltip is
                a pointer affordance, and this is the card's whole explanation. */}
            <span className="sr-only">{signInHint}</span>
          </>
        ) : null}
      </span>
    </TooltipWrapper>
  );
}

/**
 * Whether this row should offer "Sign in & enable": the provider is off, and
 * its CLI is actually on this machine.
 *
 * The host leaves a provider disabled at first boot when it found no account
 * for it, and onboarding is precisely where a user would fix that. Only for a
 * provider whose sign-in this screen can start, though - a terminal-login
 * provider's sign-in happens in a PTY, and onboarding has no epic and no
 * terminal surface to open one into, so it is excluded HERE by its own guard
 * below. It used to be excluded downstream instead, by the shared hint
 * helper, which is not the same thing: that path still MOUNTED the affordance
 * and rendered its dead "Not signed in" fallback where an action belongs. The
 * row's description says what the next gesture actually is (see
 * `accountLineFor`), and the enable switch beside it is unaffected.
 *
 * The INSTALL gate is what keeps this from becoming noise. Seeded defaults
 * leave most of a dozen-plus rows off, and offering to sign a user in to a CLI
 * they have never installed is an invitation to a failure.
 *
 * "Off" is not itself evidence of a missing account. A configured API key is
 * stored config that needs no probe, and it is the case that was actively
 * wrong rather than merely redundant: an API-key-only provider ships no
 * `oauthArgs`, so it fell to `providerSignInUnavailableHint`'s first branch
 * and rendered the affordance's "Not signed in" fallback over a key the user
 * had already set, under a hint telling them to go set one.
 *
 * THIS PREDICATE DECIDES MOUNTING, which constrains what may be read here far
 * more than correctness alone would. `SignInToEnableButton` owns the attempt,
 * and the enable runs from a per-`mutate` `onSuccess` that TanStack DROPS once
 * the observer unmounts (spelled out in `use-host-scoped-mutation.ts`). So an
 * input that flips as a RESULT of the attempt unmounts the row mid-flight and
 * strands it: the account authenticates and the provider stays off, which is
 * the single outcome this button exists to prevent.
 *
 * `state.enabled` flips that way and is safe only because it flips when the
 * work is DONE. The ambient auth verdict is not safe: `awaitLogin`'s own
 * `onSuccess` overlays the authenticated echo into `providers.list` and awaits
 * that invalidation BEFORE the per-`mutate` callback runs, so keying on it
 * unmounts the row in precisely the window the enable still needs. It belongs
 * to the button's own already-signed-in branch instead, where it changes what
 * a press DOES without changing whether the row is there to press.
 *
 * Read only inputs that are constant across an attempt.
 */
function providerNeedsSignInToEnable(
  state: ProviderCliState,
  installDetected: boolean,
): boolean {
  // Traycer's account IS the host session - there is no sign-in to perform,
  // and it seeds disabled on purpose (its inference bills credits), so the
  // toggle is the whole enable gesture. Without this guard the row would
  // render the sign-in affordance's "Not signed in" fallback, which is
  // exactly backwards for the one provider that is always signed in.
  if (state.providerId === "traycer") return false;
  if (state.apiKey.configured) return false;
  // A terminal-login provider DOES have a sign-in to perform, but not here:
  // it happens in a PTY the host opens, and onboarding has no canvas and no
  // terminal panel to open one into - a deliberate choice, not a gap. So the
  // toggle is the whole enable gesture on this screen, exactly as it is for
  // Traycer above. Without this guard the row would render the sign-in
  // affordance's "Not signed in" fallback: a dead label, tooltip'd with a
  // sentence pointing at a model picker the user has not reached yet, sitting
  // beside a switch that already works.
  //
  // `providerSupportsTerminalLogin` reads `terminalLogin` ALONE, so this is a
  // permanent provider property and safe for a MOUNT decision (see above) -
  // and it is deliberately NOT narrowed to a signed-out account or to a local
  // host. Terminal login has no locality gate (the PTY opens on whichever
  // host the composer runs on), and `authenticatedAwaitingEnable` short-
  // circuits only on a definitive `authenticated`, so a present-but-
  // unvalidated credential resolves `configured`, seeds off, and lands here
  // too.
  if (providerSupportsTerminalLogin(state.loginCapability)) return false;
  return !state.enabled && installDetected;
}

/**
 * The two auth phases the row renders from, derived together.
 *
 * ONE flag decides both, rather than each testing the auth state itself, so
 * they cannot stop being exact complements. As independent comparisons they
 * agreed only while both spelled the check the same way, and any change to one
 * would make "did not complete" and "awaiting enable" simultaneously true - a
 * failure message on a button that is in fact about to enable.
 *
 * The account is signed in EITHER because this attempt just signed it in, or
 * because it already was before the user pressed: a provider switched off by
 * hand keeps its account. Both mean the remaining gesture is the ENABLE alone,
 * so both take the same branch. Restarting a login there is not merely
 * wasteful - a CLI that refuses to start one while already signed in answers
 * `started: false`, so the press would render "sign-in did not start" and the
 * button could never complete the action it advertises, leaving no way out but
 * abandoning onboarding.
 *
 * Read HERE and not in `providerNeedsSignInToEnable`, deliberately - see that
 * function for why an attempt-dependent input must never reach the MOUNT
 * decision. At this level it changes what a press does; there it would delete
 * the row mid-attempt and strand the enable in a dropped callback.
 *
 * A pure function taking its inputs rather than a block inside the component:
 * it is the component's only non-trivial derivation, and keeping it out of the
 * render body is what holds that body inside the `complexity` budget. Not
 * exported - `react(only-export-components)` reserves this file's exports for
 * components, and the row's own tests already drive every branch through the
 * rendered button.
 */
function resolveAttemptAuthPhase(input: {
  readonly state: ProviderCliState;
  /** This attempt's completed `awaitLogin` echo, or null when none settled. */
  readonly awaitState: ProvidersAwaitLoginResponse["state"] | null;
  readonly awaitSuccess: boolean;
  readonly isPending: boolean;
}): {
  readonly authenticatedAwaitingEnable: boolean;
  readonly notAuthenticated: boolean;
  readonly hideAction: boolean;
} {
  const attemptAuthenticated =
    input.awaitSuccess &&
    input.awaitState !== null &&
    isProviderAmbientAuthenticated(input.awaitState);
  const authenticatedAwaitingEnable =
    attemptAuthenticated || isProviderAmbientAuthenticated(input.state);
  return {
    authenticatedAwaitingEnable,
    hideAction: authenticatedAwaitingEnable && !input.isPending,
    // Gated on `!isPending` so a fresh press hides the previous verdict while
    // the new attempt runs: `startLogin.mutate` does not touch `awaitLogin`,
    // so its `data` would otherwise linger across the retry it is no longer
    // about.
    notAuthenticated:
      !input.isPending && input.awaitSuccess && !authenticatedAwaitingEnable,
  };
}

const ONBOARDING_CODE_PASTE_KEEPALIVE_MS = 60_000;
const ONBOARDING_COPY_RESET_MS = 1600;

function useOnboardingWaitingCodePaste(args: {
  readonly providerId: ProviderId;
  readonly loginCapability: ProviderCliState["loginCapability"];
  readonly loginUrl: string | null;
  readonly userCode: string | null;
}): ProviderProfileLoginFlowCodePaste {
  const { providerId, loginCapability, loginUrl, userCode } = args;
  const submitLoginCode = useProvidersSubmitLoginCode();
  const touchLogin = useProvidersTouchLogin();
  const codePasteEnabled = (loginCapability?.codePaste ?? null) !== null;
  const touchLoginMutate = touchLogin.mutate;
  const attemptKey = `${loginUrl ?? ""}|${userCode ?? ""}`;
  const [acceptedAttempt, setAcceptedAttempt] = useState<string | null>(null);
  useEffect(() => {
    if (!codePasteEnabled || userCode !== null) return;
    const intervalId = window.setInterval(() => {
      touchLoginMutate({ providerId, profileId: null });
    }, ONBOARDING_CODE_PASTE_KEEPALIVE_MS);
    return () => window.clearInterval(intervalId);
  }, [codePasteEnabled, providerId, touchLoginMutate, userCode]);
  let phase: ProviderProfileLoginFlowCodePaste["phase"] = "idle";
  if (submitLoginCode.isPending) phase = "submitting";
  else if (acceptedAttempt === attemptKey) phase = "verifying";
  return {
    enabled: codePasteEnabled,
    attemptId: 0,
    restartNotice: null,
    phase,
    submitError: submitLoginCode.error,
    submit: (code) => {
      submitLoginCode.mutate(
        { providerId, profileId: null, code },
        {
          onSuccess: (result) => {
            if (result.outcome === "accepted") {
              setAcceptedAttempt(attemptKey);
            }
          },
        },
      );
    },
    touch: () => {
      touchLoginMutate({ providerId, profileId: null });
    },
  };
}

/**
 * URL, device code, and Claude paste field for onboarding's ambient sign-in.
 * The Sign in & enable button stays mounted (its enable-on-success callback
 * is dropped if this row unmounts), so this is extra affordance, not a
 * replacement for that button.
 */
function OnboardingLoginWaiting(props: {
  readonly providerId: ProviderId;
  readonly loginCapability: ProviderCliState["loginCapability"];
  readonly loginUrl: string | null;
  readonly userCode: string | null;
  readonly isLocalHost: boolean;
}): ReactNode {
  const { providerId, loginCapability, loginUrl, userCode, isLocalHost } =
    props;
  const openLink = useOpenLink();
  const autoOpen = useAutoOpenLoginUrl(
    isLocalHost,
    loginCapability,
    loginUrl,
    (url) => {
      void openLink(url, "auth", null);
    },
  );
  const { copied, copy } = useClipboardCopy({
    resetMs: ONBOARDING_COPY_RESET_MS,
    onSuccess: null,
    onError: handleSignInLinkCopyError,
  });
  const codePaste = useOnboardingWaitingCodePaste({
    providerId,
    loginCapability,
    loginUrl,
    userCode,
  });
  const processingCode = codePaste.phase !== "idle";
  const { title, guidance } = waitingStepCopy({
    phase: codePaste.phase,
    queuePending: false,
    cancelRequested: false,
    deviceCode: userCode !== null,
  });
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-live="polite">
      <div className="text-ui-xs leading-relaxed text-muted-foreground">
        <div className="font-medium text-foreground">{title}</div>
        {guidance !== null ? <p className="mt-0.5">{guidance}</p> : null}
      </div>
      {!processingCode && userCode !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="rounded-md border border-foreground/20 bg-foreground/5 px-2 py-0.5 font-mono text-ui tracking-[0.12em] text-foreground">
            {userCode}
          </code>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={copied ? "Copied sign-in code" : "Copy sign-in code"}
            onClick={() => copy(userCode)}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </div>
      ) : null}
      {!processingCode && loginUrl !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void openLink(loginUrl, "auth", null);
            }}
          >
            <ExternalLink className="size-3.5" />
            {openBrowserLabel(autoOpen)}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={copied ? "Copied sign-in link" : "Copy sign-in link"}
            onClick={() => copy(loginUrl)}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </div>
      ) : null}
      {codePaste.enabled && userCode === null ? (
        <CodePasteField
          codePaste={codePaste}
          disabled={false}
          visibleLabel={false}
        />
      ) : null}
    </div>
  );
}

/**
 * Split out so the LOGIN mutations below are instantiated ONLY on a row that
 * actually offers sign-in - the same shape as the sign-in terminal's restart
 * button. It is not a tidiness preference: `useProvidersStartLogin` and
 * `useHostScopedProvidersAwaitLogin` throw outside a `<HostRuntimeProvider>`,
 * and a row that will never start a login should not be the reason a host
 * with no auto-enablement to report needs one.
 *
 * `useHostOptions` used to be in that list and is now read once by
 * `OnboardingDetectedAgents`, which passes locality down. It costs the act
 * nothing: the list already calls `useProvidersList` (so it is inside a host
 * runtime regardless), and the page's own `useHostScopeFor` above it reads the
 * same host options unconditionally for the device pill. What it BUYS is that
 * the refusal sentence and the withheld button come from one call to one
 * helper, which is the drift `providerSignInUnavailableHint` exists to prevent.
 */
function pressSignInToEnable(
  authenticatedAwaitingEnable: boolean,
  providerId: ProviderId,
  onEnable: (providerId: ProviderId) => void,
  onSignIn: (providerId: ProviderId) => void,
): void {
  if (authenticatedAwaitingEnable) {
    onEnable(providerId);
    return;
  }
  onSignIn(providerId);
}

function showOnboardingWaitingAffordance(
  waitingLogin: {
    readonly url: string | null;
    readonly userCode: string | null;
  } | null,
  loginCapability: ProviderCliState["loginCapability"],
): boolean {
  if (waitingLogin === null) return false;
  if (waitingLogin.url !== null) return true;
  if (waitingLogin.userCode !== null) return true;
  return (loginCapability?.codePaste ?? null) !== null;
}

function SignInToEnableAlerts(props: {
  readonly declined: boolean;
  readonly declinedMessage: string;
  readonly notAuthenticated: boolean;
}): ReactNode {
  return (
    <>
      {props.declined ? (
        <span className="text-ui-xs text-destructive" role="alert">
          {props.declinedMessage}
        </span>
      ) : null}
      {props.notAuthenticated ? (
        <span className="text-ui-xs text-destructive" role="alert">
          Sign-in did not complete. This provider is still off.
        </span>
      ) : null}
    </>
  );
}

function SignInToEnableButton(props: {
  readonly state: ProviderCliState;
  /** True while the parent's `providers.setEnabled` is in flight - see
   *  `isPending` below for why this button has to know. */
  readonly enablementPending: boolean;
  readonly enablementBlocked: boolean;
  /** Locality still matters: auto-open of the returned URL is skipped on a
   *  local host when the child opens a browser itself (Claude, Antigravity).
   *  Passed in rather than read here so the ONE `useHostOptions` call also
   *  feeds the status line's refusal tooltip - see `OnboardingDetectedAgents`. */
  readonly isLocalHost: boolean;
  readonly onEnable: (providerId: ProviderId) => void;
}) {
  const { state, enablementPending, isLocalHost, onEnable } = props;
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useHostScopedProvidersAwaitLogin();
  // The gap between two re-polls is still this button working, so it counts as
  // pending: neither mutation is in flight during the timeout, and without
  // this the button would re-arm mid-settle and invite a second login child
  // for a sign-in that is about to land.
  const [settling, setSettling] = useState(false);
  const [waitingLogin, setWaitingLogin] = useState<{
    readonly url: string | null;
    readonly userCode: string | null;
  } | null>(null);
  // Pending re-poll timer, plus the latch that stops one already in flight
  // from scheduling its successor after the act has moved on. Onboarding
  // unmounts this row the moment the user advances, and a `setSettling` or an
  // enable fired into a dead tree is a React warning at best and an
  // enablement the user never sees at worst.
  const repollTimerRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  // Cleared on every effect RUN, not just at declaration: StrictMode's dev
  // double-invoke is setup -> cleanup -> setup, so a latch only ever set would
  // stay on for the life of a mounted button and make every completion and
  // re-poll return early - the sign-in would complete and never enable, in
  // exactly the builds a developer tests onboarding in. Same reason, and the
  // same shape, as the Settings login flow's own latch.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (repollTimerRef.current !== null) {
        window.clearTimeout(repollTimerRef.current);
        repollTimerRef.current = null;
      }
    };
  }, []);
  // Pending until the ADVERTISED action is done, which is the enable, not the
  // authentication: `providers.setEnabled` is the parent's mutation, so
  // without its flag this button re-arms in the window between a successful
  // login and the row flipping enabled - long enough for a second press to
  // spawn a redundant login child for a provider that is already being turned
  // on. Only this provider's enable request drives its loading state.
  const isPending =
    startLogin.isPending ||
    awaitLogin.isPending ||
    settling ||
    enablementPending;
  // The RPC succeeded but the host declined to start the login, so the
  // provider tooling is the limiting factor, not auth - the same outcome
  // Settings names `failureMessages.notStarted`, and the one edge that could
  // otherwise dead-end silently (the mutation's own failures already toast
  // through `toastFromHostError`).
  //
  // Surfaced as an INLINE row error rather than a component-level
  // `toast.error`, which the GUI rules forbid and which would have been the
  // only ad-hoc one in this act. DERIVED from the mutation result rather than
  // held in `useState`: the result already is this state, and `mutate` resets
  // it at the next attempt, so the message clears itself on retry instead of
  // needing an effect to.
  const declined = startLogin.isSuccess && !startLogin.data.started;
  const declinedMessage = providerStartLoginFailureMessage(
    startLogin.data?.failure,
    "Sign-in did not start. Try again.",
  );
  // The counterpart to `declined`, for a login that STARTED and then did not
  // produce an authenticated account: a cancelled browser login, a settled
  // "not authenticated", or a re-poll budget spent without a verdict. All three
  // used to end the attempt by simply stopping the spinner - the row kept its
  // previous appearance and the button re-armed, so the one thing the user
  // needed to know (this provider is still off) was left to be inferred from a
  // switch that had not moved. On a screen whose button promises "sign in TO
  // ENABLE", the enable silently not happening is the outcome that most needs
  // saying.
  //
  // DERIVED, for the same reason `declined` is: `awaitLogin.data` already holds
  // the last completion, so there is no second copy of this state to keep in
  // step and nothing to reset on the next attempt. Gated on `!isPending` so a
  // fresh press hides the previous verdict while the new attempt runs -
  // `startLogin.mutate` does not touch `awaitLogin`, so its `data` would
  // otherwise linger across the retry it is no longer about.
  //
  // Mutually exclusive with `declined`, but only because `onSignIn` RESETS the
  // await mutation before each attempt. Without that reset the two are not
  // exclusive at all across attempts: `awaitLogin` keeps the previous
  // completion, so an attempt whose `startLogin` came back `started: false`
  // would end pending having never called `awaitLogin`, and the row would
  // render "did not start" and "did not complete" together - the second one
  // describing an attempt the user had already moved on from.
  const { authenticatedAwaitingEnable, notAuthenticated, hideAction } =
    resolveAttemptAuthPhase({
      state,
      awaitSuccess: awaitLogin.isSuccess,
      awaitState: awaitLogin.data?.state ?? null,
      isPending,
    });
  const onSignIn = (providerId: ProviderId): void => {
    // Scope the await result to THIS attempt. `startLogin.mutate` resets its
    // own result and so clears `declined` on its own; `awaitLogin` is a
    // separate mutation that nothing else touches, so its verdict has to be
    // dropped explicitly or it outlives the attempt it belongs to.
    awaitLogin.reset();
    setWaitingLogin(null);
    // Start, then await the honest completion edge, then ENABLE.
    //
    // That third step is not a convenience, it is the whole contract: signing
    // in does not enable a provider anywhere in this app, because a sign-in
    // from the re-auth rail is a user fixing something they already chose, not
    // asking for a new row in their picker. Onboarding is the one screen where
    // the two gestures genuinely coincide - the button says "sign in TO
    // ENABLE" - so this screen states the enablement explicitly rather than
    // relying on the host to infer it from a credential appearing.
    startLogin.mutate(
      // Ambient login, not a managed profile: onboarding has no profile
      // management surface, and the account a first sign-in creates is the
      // provider's own CLI login.
      { providerId, profileId: null, createProfile: null },
      {
        onSuccess: (result) => {
          if (!result.started) return;
          setWaitingLogin({
            url: result.url ?? null,
            userCode: result.userCode ?? null,
          });
          // Per-attempt budget, scoped to this closure so a later press starts
          // over with a full one - the same shape Settings' login flow gives
          // each attempt.
          let repolls = 0;
          const scheduleRepoll = (): boolean => {
            if (repolls >= AMBIENT_AUTH_PENDING_REPOLL_CAP) return false;
            repolls += 1;
            setSettling(true);
            repollTimerRef.current = window.setTimeout(() => {
              repollTimerRef.current = null;
              if (unmountedRef.current) return;
              awaitOnce();
            }, AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
            return true;
          };
          // Only a COMPLETED, authenticated login enables: `state` is null when
          // the host has no settled outcome to report, and a cancelled or
          // failed sign-in must not leave the user with a provider they never
          // got to use.
          //
          // An unsettled ambient verdict is not a failure, though - it is the
          // host's auth probe still running behind a login that may well have
          // succeeded (see `isAmbientAuthVerdictPending`). Deciding on it would
          // make the button's advertised action silently not happen, which is
          // the one outcome a screen called "Sign in & enable" cannot have. So
          // the same bounded re-poll Settings runs applies here, and only a
          // settled - or budget-exhausted - "not authenticated" stops the
          // chain.
          const handleCompletion = (
            completion: ProvidersAwaitLoginResponse,
          ): void => {
            if (unmountedRef.current) return;
            // The verdict is the SHARED ambient one, not the top-level status
            // alone. Those two signals reflect the same login and converge at
            // different times, so reading only the summary is wrong in both
            // directions: an ambient row that authenticates first would burn
            // the whole re-poll budget and leave the provider off, and a stale
            // top-level `authenticated` would enable a provider whose ambient
            // row definitively says `unauthenticated`.
            if (
              completion.state !== null &&
              isProviderAmbientAuthenticated(completion.state)
            ) {
              setWaitingLogin(null);
              setSettling(false);
              onEnable(providerId);
              return;
            }
            if (
              completion.state !== null &&
              isAmbientAuthVerdictPending(completion.state) &&
              scheduleRepoll()
            ) {
              return;
            }
            setWaitingLogin(null);
            setSettling(false);
          };
          const awaitOnce = (): void => {
            awaitLogin.mutate(
              { providerId, profileId: null },
              {
                onSuccess: handleCompletion,
                // A failed await ends the attempt: the mutation's own
                // `onError` has already toasted, and re-polling a transport
                // failure would only stretch the spinner over it.
                onError: () => {
                  if (unmountedRef.current) return;
                  setWaitingLogin(null);
                  setSettling(false);
                },
              },
            );
          };
          awaitOnce();
        },
      },
    );
  };
  // One helper answers both "can this start" and "why not", so the button and
  // its tooltip cannot disagree - the drift this helper was extracted to stop.
  //
  // Not asked at all once the account is signed in, because the question is
  // about starting a LOGIN and there is no longer one to start. Asking anyway
  // is not a harmless extra gate: the helper is non-null for a remote host and
  // for any provider with no `oauthArgs`, so its early return would render a
  // flatly false "Not signed in" over an authenticated account AND withhold
  // the enable - which is the only action left, and the one this component
  // exists to perform. It also made the direct-enable branch below
  // structurally unreachable for exactly those combinations.
  //
  // A terminal-login provider used to be the third member of that list and no
  // longer reaches this component at all: `providerNeedsSignInToEnable` now
  // refuses to mount it, so the whole class is answered one level up by the
  // row's description rather than by a fallback label here. Nothing is
  // withheld by that - the enable switch is this component's SIBLING and
  // renders unconditionally.
  const unavailableHint = authenticatedAwaitingEnable
    ? null
    : providerSignInUnavailableHint(state, isLocalHost);
  if (hideAction) return null;
  // Nothing in the footer. The refusal used to be a grey caption on every card
  // whose provider has no headless sign-in - most of them - which made a third
  // line of micro-copy the dominant texture of the board. The reason now rides
  // the status line's info glyph and its accessible name, computed from the
  // same helper in `OnboardingDetectedAgents`.
  if (unavailableHint !== null) return null;
  const waitingLoginToShow = showOnboardingWaitingAffordance(
    waitingLogin,
    state.loginCapability,
  )
    ? waitingLogin
    : null;
  return (
    <span className="flex min-w-0 flex-col items-stretch gap-2">
      {waitingLoginToShow !== null ? (
        <OnboardingLoginWaiting
          providerId={state.providerId}
          loginCapability={state.loginCapability}
          loginUrl={waitingLoginToShow.url}
          userCode={waitingLoginToShow.userCode}
          isLocalHost={isLocalHost}
        />
      ) : null}
      <span className="flex min-w-0 flex-col items-stretch gap-1.5">
        <SignInToEnableAlerts
          declined={declined}
          declinedMessage={declinedMessage}
          notAuthenticated={notAuthenticated}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={[isPending, props.enablementBlocked].includes(true)}
          aria-busy={isPending}
          className="w-full disabled:opacity-100"
          onClick={() =>
            pressSignInToEnable(
              authenticatedAwaitingEnable,
              state.providerId,
              onEnable,
              onSignIn,
            )
          }
        >
          Sign in &amp; enable
          {/* Unchanged label + inline spinner: starting a login spawns the
              provider CLI host-side, so a press with no feedback invites a
              second one. */}
          {isPending ? <MutedAgentSpinner /> : null}
        </Button>
      </span>
    </span>
  );
}

/**
 * The phone row's one line: the status word, then the discovery counts when
 * this provider reports any. Built for every row on every viewport and
 * rendered only in the phone shape, which costs nothing - an element that is
 * not rendered mounts no query.
 *
 * A component rather than an expression in the row mapper so the mapper keeps
 * one branch fewer; it owns the `state === undefined` case itself.
 */
function ProviderPhoneDescription(props: {
  readonly state: ProviderCliState | undefined;
  readonly installDetected: boolean;
  readonly installState: InstallState;
  readonly hostUnavailable: boolean;
}) {
  const { state, installDetected, installState, hostUnavailable } = props;
  return (
    <>
      {phoneStatusFor({
        state,
        installDetected,
        installState,
        hostUnavailable,
      })}
      {state === undefined ? null : (
        <OnboardingProviderDiscovery
          state={state}
          visible
          presentation="text"
        />
      )}
    </>
  );
}

/**
 * The agents act's provider panel. Once past sign-in the host's
 * `providers.list` returns real state, so each row shows the CLI, its
 * one-liner, install + account status, and an enable/disable toggle. When no
 * host is reachable (cold desktop boot) the rows degrade to a quiet
 * "Unavailable" instead of erroring.
 */
export function OnboardingDetectedAgents() {
  // The agents act is on-screen and active while mounted, so keep the query
  // both enabled and subscribed to cache updates.
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  // Read from the shared host list every picker in the app reads, not
  // Settings' scoped `useHostScope`.
  const { hosts } = useHostOptions();
  const isLocalHost =
    hosts.find((host) => host.isActive)?.isLocalMachine ?? false;
  const providers = providersQuery.data?.providers;
  const setEnabled = useProvidersSetEnabled();
  const [pinnedOrder, setPinnedOrder] =
    useState<ReadonlyArray<OrderedProvider> | null>(null);
  // A disabled query (no host bound yet) never leaves `pending` with an idle
  // fetch, and a hard query error leaves no data; surface both honestly as
  // "Unavailable" instead of an eternal "Detecting…".
  const hostUnavailable =
    (providersQuery.isPending && providersQuery.fetchStatus === "idle") ||
    (providersQuery.isError && providers === undefined);
  const enabledProviderCount =
    providers?.filter((provider) => provider.enabled).length ?? 0;

  const orderedProviders =
    pinnedOrder ??
    orderProvidersByEnablement((providerId) =>
      enabledForProvider(providerStateFor(providers, providerId)),
    );
  const handleSetEnabled = (providerId: ProviderId, enabled: boolean): void => {
    if (setEnabled.isPending) return;
    // Keep cards under the pointer after the user starts choosing.
    setPinnedOrder(orderedProviders);
    // No profile management UI yet - this call never renames/removes a profile.
    setEnabled.mutate({
      providerId,
      enabled,
      profileAction: null,
    });
  };
  // Enabled providers first. The host's one-time seeding enables only the
  // accounts the user actually has, so without this the two or three rows that
  // matter sit scattered among a dozen-plus they have never used.
  const rows = orderedProviders.map(({ providerId }): ProviderListRow => {
    const state = providerStateFor(providers, providerId);
    const enabled = enabledForProvider(state);
    const traycerProvider = providerId === "traycer";
    const installState = traycerProvider ? "detected" : installStateFor(state);
    const installLabel = installLabelFor(
      traycerProvider,
      hostUnavailable,
      installState,
    );
    const installDetected =
      traycerProvider || (!hostUnavailable && installState === "detected");
    const disablingLastEnabled = disablingLastEnabledFor(
      state,
      enabled,
      enabledProviderCount,
    );
    // The card's recessive channel. Enablement is already spoken by the ring
    // and the check, so this is the other axis: a CLI the machine does not
    // have is the one thing the user can do nothing about here.
    const dimmed = !installDetected;
    // Why this card offers no "Sign in & enable", asked only where it would
    // otherwise have offered one. Gated on the AMBIENT verdict rather than the
    // button's `authenticatedAwaitingEnable`, which folds in this attempt's
    // echo: that half is attempt-dependent and must not reach the row model
    // (see `providerNeedsSignInToEnable`). The two can differ for one render
    // after a login lands, and only in the direction that retires the hint.
    const signInHint =
      state !== undefined &&
      providerNeedsSignInToEnable(state, installDetected) &&
      !isProviderAmbientAuthenticated(state)
        ? providerSignInUnavailableHint(state, isLocalHost)
        : null;
    return {
      providerId,
      active: false,
      dimmed,
      enabled: state?.enabled ?? null,
      badge: null,
      description: providerStatusLine(
        state,
        installDetected,
        installLabel,
        signInHint,
      ),
      phoneDescription: (
        <ProviderPhoneDescription
          state={state}
          installDetected={installDetected}
          installState={installState}
          hostUnavailable={hostUnavailable}
        />
      ),
      // A FRAGMENT, not a wrapper: both children render nothing on a card with
      // no discoveries and no sign-in to offer, and the list's footer hides
      // itself only while it is genuinely empty.
      trailing:
        state === undefined ? null : (
          <>
            <OnboardingProviderDiscovery
              state={state}
              visible
              presentation="popover"
            />
            {providerNeedsSignInToEnable(state, installDetected) ? (
              <SignInToEnableButton
                state={state}
                isLocalHost={isLocalHost}
                enablementBlocked={setEnabled.isPending}
                enablementPending={
                  setEnabled.isPending
                    ? setEnabled.variables.providerId === providerId
                    : false
                }
                onEnable={(providerId) => handleSetEnabled(providerId, true)}
              />
            ) : null}
          </>
        ),
      disabledReason: disablingLastEnabled
        ? "At least one provider must stay enabled."
        : null,
      onSelect:
        state === undefined || setEnabled.isPending || disablingLastEnabled
          ? null
          : (providerId) => handleSetEnabled(providerId, !enabled),
    };
  });

  const installedProviderCount =
    providers?.filter(
      (provider) =>
        provider.providerId === "traycer" ||
        installStateFor(provider) === "detected",
    ).length ?? 0;
  let discoveryStatus = "Finding your providers…";
  if (hostUnavailable)
    discoveryStatus = "Connect a device to check your accounts";
  else if (providers !== undefined)
    discoveryStatus = `${enabledProviderCount} enabled · ${installedProviderCount} installed`;

  return (
    <div className="onboarding-provider-agents flex min-h-0 flex-1 flex-col">
      <div className="onboarding-provider-status flex shrink-0 items-center justify-end gap-3">
        <p
          role="status"
          className="flex min-w-0 items-center gap-2 text-ui-xs tabular-nums text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              enabledProviderCount > 0 ? "bg-success" : "bg-foreground/30",
            )}
          />
          <span className="min-w-0 truncate">{discoveryStatus}</span>
        </p>
        {providersQuery.isError ? (
          <button
            type="button"
            onClick={() => void providersQuery.refetch()}
            className="shrink-0 rounded text-ui-xs text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            Try again
          </button>
        ) : null}
      </div>
      <OnboardingProviderGrid rows={rows} />
    </div>
  );
}
