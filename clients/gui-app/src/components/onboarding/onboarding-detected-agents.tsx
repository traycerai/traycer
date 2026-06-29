import {
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { ReactNode } from "react";
import { ProviderList } from "@/components/providers/provider-list";
import type { ProviderListRow } from "@/components/providers/provider-list";
import { Switch } from "@/components/ui/switch";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import {
  ORDERED_PROVIDERS,
  providerDisplayName,
} from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

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
    <span
      title={account.title ?? undefined}
      className={cn(
        account.tone === "good" ? "text-[#7fd6a4]" : "text-white/45",
      )}
    >
      {account.text}
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
    <Switch
      checked={enabled}
      onCheckedChange={(next) => {
        if (isSettingEnabled || (!next && disablingLastEnabled)) return;
        onSetEnabled(providerId, next);
      }}
      disabled={isSettingEnabled || disablingLastEnabled}
      aria-label={`Enable ${name}`}
      title={
        disablingLastEnabled
          ? "At least one provider must stay enabled."
          : undefined
      }
      className="ml-auto"
    />
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
    setEnabled.mutate({ providerId, enabled });
  };
  const rows = ORDERED_PROVIDERS.map(({ providerId }): ProviderListRow => {
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
          <ProviderEnableSwitch
            providerId={state.providerId}
            name={name}
            enabled={enabled}
            disablingLastEnabled={disablingLastEnabled}
            isSettingEnabled={setEnabled.isPending}
            onSetEnabled={handleSetEnabled}
          />
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
