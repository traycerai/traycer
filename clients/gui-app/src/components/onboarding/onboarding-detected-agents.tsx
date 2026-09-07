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
  dimmed: boolean,
): ReactNode {
  return (
    <span
      className={cn(
        "font-mono text-overline uppercase tracking-wider",
        installDetected ? "text-[#7fd6a4]" : "text-white/40",
        // The list deliberately leaves a dimmed row's opacity alone so the
        // row's controls stay readable, so the badge recedes on its own.
        dimmed && "opacity-60",
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

/** Seeded defaults leave most of a dozen-plus rows off, and offering to sign a user in to a CLI they have never
 * installed is an invitation to a failure. */
function providerNeedsSignInToEnable(
  state: ProviderCliState,
  installDetected: boolean,
): boolean {
  // Without this guard the row would render the sign-in affordance's "Not signed in" fallback, which is exactly
  // backwards for the one provider that is always signed in.
  if (state.providerId === "traycer") return false;
  if (state.apiKey.configured) return false;
  return !state.enabled && installDetected;
}

/** Read here and not in `providerNeedsSignInToEnable`, deliberately - see that function for why an
 * attempt-dependent input must never reach the mount decision. */
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
    // Gated on `!isPending` so a fresh press hides the previous verdict while the new attempt runs.
    notAuthenticated:
      !input.isPending && input.awaitSuccess && !authenticatedAwaitingEnable,
  };
}

/** It is not a tidiness preference: `useProvidersStartLogin`, `useHostScopedProvidersAwaitLogin` and
 * `useHostOptions` all throw outside a `<HostRuntimeProvider>`. */
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
  // Browser OAuth opens a browser on the machine running the host, so it is only offerable when that machine is
  // this one.
  const { hosts } = useHostOptions();
  const isLocalHost =
    hosts.find((host) => host.isActive)?.isLocalMachine ?? false;
  // The gap between two re-polls is still this button working, so it counts as pending.
  const [settling, setSettling] = useState(false);
  // Pending re-poll timer, plus the latch that stops one already in flight from scheduling its successor after
  // the act has moved on.
  const repollTimerRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  // Cleared on every effect run, not just at declaration.
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
  // Pending until the advertised action is done, which is the enable, not the authentication.
  const isPending =
    startLogin.isPending ||
    awaitLogin.isPending ||
    settling ||
    enablementPending;
  // Surfaced as an inline row error rather than a component-level `toast.error`, which the GUI rules forbid and
  // which would have been the only ad-hoc one in this act.
  const declined = startLogin.isSuccess && !startLogin.data.started;
  // Without that reset the two are not exclusive at all across attempts: `awaitLogin` keeps the previous
  // completion, so an attempt whose `startLogin` came back `started.
  const { authenticatedAwaitingEnable, notAuthenticated } =
    resolveAttemptAuthPhase({
      state,
      awaitSuccess: awaitLogin.isSuccess,
      awaitState: awaitLogin.data?.state ?? null,
      isPending,
    });
  const onSignIn = (providerId: ProviderId): void => {
    // `startLogin.mutate` resets its own result and so clears `declined` on its own.
    awaitLogin.reset();
    // Onboarding is the one screen where the two gestures genuinely coincide - the button says "sign in TO
    // enable".
    startLogin.mutate(
      // Ambient login, not a managed profile: onboarding has no profile management surface, and the account a first
      // sign-in creates is the provider's own CLI login.
      { providerId, profileId: null, createProfile: null },
      {
        onSuccess: (result) => {
          if (!result.started) return;
          // Per-attempt budget, scoped to this closure so a later press starts over with a full one - the same shape
          // Settings' login flow gives each attempt.
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
          // Only a completed, authenticated login enables: `state` is null when the host has no settled outcome to
          // report, and a cancelled or failed sign-in must not leave the user with a provider they never got to use.
          const handleCompletion = (
            completion: ProvidersAwaitLoginResponse,
          ): void => {
            if (unmountedRef.current) return;
            // Those two signals reflect the same login and converge at different times, so reading only the summary is
            // wrong in both directions.
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
                // A failed await ends the attempt: the mutation's own `onError` has already toasted, and re-polling a
                // transport failure would only stretch the spinner over it.
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
  // One helper answers both "can this start" and "why not", so the button and its tooltip cannot disagree - the
  // drift this helper was extracted to stop.
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
        Sign in &amp; enable
        {/* Unchanged label + inline spinner: starting a login spawns the provider CLI host-side, so a press with no
           feedback invites a second one. */}
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

/** When no host is reachable (cold desktop boot) the rows degrade to a quiet "Unavailable" instead of erroring. */
export function OnboardingDetectedAgents() {
  // The agents act is on-screen and active while mounted, so keep the query
  // both enabled and subscribed to cache updates.
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  const providers = providersQuery.data?.providers;
  const setEnabled = useProvidersSetEnabled();
  // A disabled query (no host bound yet) never leaves `pending` with an idle fetch, and a hard query error
  // leaves no data; surface both honestly as "Unavailable" instead of an eternal "Detecting…".
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
  // The host's one-time seeding enables only the accounts the user actually has, so without this the two or
  // three rows that matter sit scattered among a dozen-plus they have never used.
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
    const dimmed = state !== undefined && !enabled;
    return {
      providerId,
      active: false,
      dimmed,
      enabled: state?.enabled ?? null,
      badge: installBadge(installDetected, installLabel, dimmed),
      description: accountDescription(state),
      trailing:
        state === undefined ? null : (
          <div className="ml-auto flex items-center gap-2">
            {/* Beside the switch, not instead of it: the switch still states sticky intent, and this only answers the
               reason the provider is off. A user who wants it on regardless can still say so. */}
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
