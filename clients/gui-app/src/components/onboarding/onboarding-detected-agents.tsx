import {
  type ProviderCliState,
  type ProviderId,
  type ProvidersAwaitLoginResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ProviderList } from "@/components/providers/provider-list";
import type { ProviderListRow } from "@/components/providers/provider-list";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Switch } from "@/components/ui/switch";
import { providerSignInUnavailableHint } from "@/components/providers/provider-signin-availability";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import { useProvidersStartLogin } from "@/hooks/providers/use-providers-start-login-mutation";
import { useHostScopedProvidersAwaitLogin } from "@/hooks/providers/use-providers-await-login-mutation";
import {
  AMBIENT_AUTH_PENDING_REPOLL_CAP,
  AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS,
  isAmbientAuthVerdictPending,
  isProviderAmbientAuthenticated,
} from "@/lib/providers/provider-ambient-auth";
import {
  orderProvidersByEnablement,
  providerDisplayName,
} from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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
  missing: "Not found",
  pending: "Detecting…",
};

interface AccountLine {
  readonly text: string;
  readonly tone: "good" | "muted";
  readonly title: string | null;
}

/** Mirrors `ProviderAuthLine`, restyled for the cinematic copy column. */
function accountLineFor(state: ProviderCliState): AccountLine {
  if (state.providerId === "traycer" && state.enabled) {
    return {
      text: "Ready with your Traycer subscription",
      tone: "good",
      title: null,
    };
  }
  if (!state.enabled) return { text: "Disabled", tone: "muted", title: null };
  const { auth } = state;
  if (state.authPending) {
    return { text: "Checking account…", tone: "muted", title: null };
  }
  if (auth.status === "authenticated") {
    return {
      text: auth.label ?? "Signed in",
      tone: "good",
      title: auth.detail,
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
  if (auth.status === "unauthenticated") {
    return { text: "Not signed in", tone: "muted", title: null };
  }
  if (state.apiKey.configured) {
    return { text: "API key set", tone: "good", title: null };
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

function installBadge(
  installDetected: boolean,
  installLabel: string,
): ReactNode {
  return (
    <span
      className={cn(
        "font-mono text-overline uppercase tracking-wider",
        installDetected ? "text-[#7fd6a4]" : "text-white/40",
      )}
    >
      {installLabel}
    </span>
  );
}

function accountDescription(state: ProviderCliState | undefined): ReactNode {
  if (state === undefined) return null;
  const account = accountLineFor(state);
  return (
    <TooltipWrapper
      label={account.title ?? undefined}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className={cn(
          account.tone === "good" ? "text-[#7fd6a4]" : "text-white/45",
        )}
      >
        {account.text}
      </span>
    </TooltipWrapper>
  );
}

/**
 * Whether this row should offer "Sign in to enable": the provider is off, and
 * its CLI is actually on this machine.
 *
 * The host leaves a provider disabled at first boot when it found no account
 * for it, and onboarding is precisely where a user would fix that. Only for a
 * provider whose sign-in this screen can start, though - terminal-login
 * providers are excluded by the shared hint helper, which is the point of
 * reusing it: onboarding has no epic and no terminal surface to open one into.
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
} {
  const attemptAuthenticated =
    input.awaitSuccess &&
    input.awaitState !== null &&
    isProviderAmbientAuthenticated(input.awaitState);
  const authenticatedAwaitingEnable =
    attemptAuthenticated || isProviderAmbientAuthenticated(input.state);
  return {
    authenticatedAwaitingEnable,
    // Gated on `!isPending` so a fresh press hides the previous verdict while
    // the new attempt runs: `startLogin.mutate` does not touch `awaitLogin`,
    // so its `data` would otherwise linger across the retry it is no longer
    // about.
    notAuthenticated:
      !input.isPending && input.awaitSuccess && !authenticatedAwaitingEnable,
  };
}

/**
 * Split out so the host-runtime hooks below are instantiated ONLY on a row
 * that actually offers sign-in - the same shape as the sign-in terminal's
 * restart button. It is not a tidiness preference: `useProvidersStartLogin`,
 * `useHostScopedProvidersAwaitLogin` and `useHostOptions` all throw outside a
 * `<HostRuntimeProvider>`, so calling them in the list component would make
 * this whole act require one even on a host that has no auto-enablement to
 * report and would never render a single one of these buttons.
 */
function SignInToEnableButton(props: {
  readonly state: ProviderCliState;
  /** True while the parent's `providers.setEnabled` is in flight - see
   *  `isPending` below for why this button has to know. */
  readonly enablementPending: boolean;
  readonly onEnable: (providerId: ProviderId) => void;
}) {
  const { state, enablementPending, onEnable } = props;
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useHostScopedProvidersAwaitLogin();
  // Browser OAuth opens a browser on the machine running the host, so it is
  // only offerable when that machine is this one. Read from the shared host
  // list every picker in the app reads, not Settings' scoped `useHostScope`.
  const { hosts } = useHostOptions();
  const isLocalHost =
    hosts.find((host) => host.isActive)?.isLocalMachine ?? false;
  // The gap between two re-polls is still this button working, so it counts as
  // pending: neither mutation is in flight during the timeout, and without
  // this the button would re-arm mid-settle and invite a second login child
  // for a sign-in that is about to land.
  const [settling, setSettling] = useState(false);
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
  // on. The parent's flag is shared across rows, exactly like the enable
  // switches it already drives.
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
  const { authenticatedAwaitingEnable, notAuthenticated } =
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
          // the one outcome a screen called "Sign in to enable" cannot have. So
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
  // is not a harmless extra gate: the helper is non-null for a remote host, a
  // terminal-login provider, and any provider with no `oauthArgs`, so its
  // early return would render a flatly false "Not signed in" over an
  // authenticated account AND withhold the enable - which is the only action
  // left, and the one this component exists to perform. It also made the
  // direct-enable branch below structurally unreachable for exactly those
  // combinations.
  const unavailableHint = authenticatedAwaitingEnable
    ? null
    : providerSignInUnavailableHint(state, isLocalHost);
  if (unavailableHint !== null) {
    return (
      <TooltipWrapper
        label={unavailableHint}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="text-ui-xs text-white/40">Not signed in</span>
      </TooltipWrapper>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      {declined ? (
        <span className="text-ui-xs text-destructive" role="alert">
          Sign-in did not start. Try again when ready.
        </span>
      ) : null}
      {notAuthenticated ? (
        <span className="text-ui-xs text-destructive" role="alert">
          Sign-in did not complete. This provider is still off.
        </span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => {
          if (authenticatedAwaitingEnable) {
            onEnable(state.providerId);
            return;
          }
          onSignIn(state.providerId);
        }}
      >
        Sign in to enable
        {/* Unchanged label + inline spinner: starting a login spawns the
            provider CLI host-side, so a press with no feedback invites a
            second one. */}
        {isPending ? <MutedAgentSpinner /> : null}
      </Button>
    </span>
  );
}

function ProviderEnableSwitch(props: {
  readonly providerId: ProviderId;
  readonly name: string;
  readonly enabled: boolean;
  readonly disablingLastEnabled: boolean;
  readonly isSettingEnabled: boolean;
  readonly onSetEnabled: (providerId: ProviderId, enabled: boolean) => void;
}) {
  const {
    providerId,
    name,
    enabled,
    disablingLastEnabled,
    isSettingEnabled,
    onSetEnabled,
  } = props;
  return (
    <TooltipWrapper
      label={
        disablingLastEnabled ? "At least one provider must stay enabled." : null
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {/* Guard span: the Switch is `disabled` in exactly the state this
          explains, and a disabled control emits no pointer events. */}
      <span className="ml-auto inline-flex">
        <Switch
          checked={enabled}
          onCheckedChange={(next) => {
            if (isSettingEnabled || (!next && disablingLastEnabled)) return;
            onSetEnabled(providerId, next);
          }}
          disabled={isSettingEnabled || disablingLastEnabled}
          aria-label={`Enable ${name}`}
        />
      </span>
    </TooltipWrapper>
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
  const providers = providersQuery.data?.providers;
  const setEnabled = useProvidersSetEnabled();
  // A disabled query (no host bound yet) never leaves `pending` with an idle
  // fetch, and a hard query error leaves no data; surface both honestly as
  // "Unavailable" instead of an eternal "Detecting…".
  const hostUnavailable =
    (providersQuery.isPending && providersQuery.fetchStatus === "idle") ||
    (providersQuery.isError && providers === undefined);
  const enabledProviderCount =
    providers?.filter((provider) => provider.enabled).length ?? 0;

  const handleSetEnabled = (providerId: ProviderId, enabled: boolean): void => {
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
  const rows = orderProvidersByEnablement((providerId) =>
    enabledForProvider(providerStateFor(providers, providerId)),
  ).map(({ providerId }): ProviderListRow => {
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
    const name = providerDisplayName(providerId);
    return {
      providerId,
      active: false,
      dimmed: state !== undefined && !enabled,
      enabled: state?.enabled ?? null,
      badge: installBadge(installDetected, installLabel),
      description: accountDescription(state),
      trailing:
        state === undefined ? null : (
          <div className="ml-auto flex items-center gap-2">
            {/* Beside the switch, not instead of it: the switch still states
                sticky intent, and this only answers the reason the provider is
                off. A user who wants it on regardless can still say so. */}
            {providerNeedsSignInToEnable(state, installDetected) ? (
              <SignInToEnableButton
                state={state}
                enablementPending={setEnabled.isPending}
                onEnable={(providerId) => {
                  handleSetEnabled(providerId, true);
                }}
              />
            ) : null}
            <ProviderEnableSwitch
              providerId={state.providerId}
              name={name}
              enabled={enabled}
              disablingLastEnabled={disablingLastEnabled}
              isSettingEnabled={setEnabled.isPending}
              onSetEnabled={handleSetEnabled}
            />
          </div>
        ),
      onSelect: null,
    };
  });

  return (
    <ProviderList
      ariaLabel="Coding agent CLIs"
      variant="onboarding"
      rows={rows}
      className="my-auto flex max-h-full min-h-0 w-full flex-col gap-2.5 overflow-y-auto overscroll-contain pr-2"
    />
  );
}
