import {
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { ReactNode } from "react";
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
 * Whether this row should offer "Sign in to enable".
 *
 * Under auto-enablement a provider with no detected account is effectively
 * disabled, and onboarding is precisely where a user would fix that - but only
 * for a provider whose sign-in this screen can actually start. Terminal-login
 * providers are excluded by the shared hint helper, which is the point of
 * reusing it: onboarding has no epic and no terminal surface to open one into,
 * so offering the button here would be a dead end.
 *
 * Gated on `enablementSource` when the host sends it, so the CTA appears for
 * exactly the providers auto-enablement turned off. On an older host the field
 * is absent, no row is auto-undetected, and onboarding keeps its current shape
 * with no sign-in buttons - the surface does not regress, it just gains
 * nothing.
 */
function providerNeedsSignInToEnable(state: ProviderCliState): boolean {
  return state.enablementSource === "auto-undetected";
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
function SignInToEnableButton(props: { readonly state: ProviderCliState }) {
  const { state } = props;
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useHostScopedProvidersAwaitLogin();
  // Browser OAuth opens a browser on the machine running the host, so it is
  // only offerable when that machine is this one. Read from the shared host
  // list every picker in the app reads, not Settings' scoped `useHostScope`.
  const { hosts } = useHostOptions();
  const isLocalHost =
    hosts.find((host) => host.isActive)?.isLocalMachine ?? false;
  const isPending = startLogin.isPending || awaitLogin.isPending;
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
  const onSignIn = (providerId: ProviderId): void => {
    // Start, then await the honest completion edge. The await is what makes
    // this worth wiring at all: its `onSuccess` overlays the fresh state onto
    // `providers.list` and re-reads the row, so a provider that was
    // auto-disabled for want of an account becomes usable without a restart.
    startLogin.mutate(
      // Ambient login, not a managed profile: onboarding has no profile
      // management surface, and the account a first sign-in creates is the
      // provider's own CLI login.
      { providerId, profileId: null, createProfile: null },
      {
        onSuccess: (result) => {
          if (!result.started) return;
          awaitLogin.mutate({ providerId, profileId: null });
        },
      },
    );
  };
  // One helper answers both "can this start" and "why not", so the button and
  // its tooltip cannot disagree - the drift this helper was extracted to stop.
  const unavailableHint = providerSignInUnavailableHint(state, isLocalHost);
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => onSignIn(state.providerId)}
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
    //
    // Deliberately still the BINARY call, with no `mode`, even though the host
    // now stores a tri-state. Onboarding is the one screen whose entire purpose
    // is the user stating which agents they want, so a toggle here IS sticky
    // intent - which is exactly what `enabled` maps to (`setProviderEnabled`
    // writes `on`/`off`). Offering Auto here would ask a first-time user to
    // reason about a mechanism they have not met yet, and Settings owns that
    // choice.
    setEnabled.mutate({
      providerId,
      enabled,
      profileAction: null,
    });
  };
  // Enabled providers first. On a fresh install auto-enablement lights up only
  // the accounts the user actually has, so without this the two or three rows
  // that matter sit scattered among a dozen-plus they have never used.
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
            {providerNeedsSignInToEnable(state) ? (
              <SignInToEnableButton state={state} />
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
