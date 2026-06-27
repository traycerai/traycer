import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { Switch } from "@/components/ui/switch";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import { cn } from "@/lib/utils";

const TOUR_PROVIDERS: ReadonlyArray<{
  id: ProviderId;
  harnessId: GuiHarnessId;
}> = [
  { id: "traycer", harnessId: "traycer" },
  { id: "claude-code", harnessId: "claude" },
  { id: "codex", harnessId: "codex" },
  { id: "opencode", harnessId: "opencode" },
  { id: "cursor", harnessId: "cursor" },
  { id: "grok", harnessId: "grok" },
  { id: "kiro", harnessId: "kiro" },
  { id: "droid", harnessId: "droid" },
  { id: "kimi", harnessId: "kimi" },
  { id: "copilot", harnessId: "copilot" },
  { id: "kilocode", harnessId: "kilocode" },
];

type InstallState = "detected" | "missing" | "pending";

function providerDisplayName(providerId: ProviderId): string {
  if (providerId === "traycer") return "Traycer Inference";
  return PROVIDER_DISPLAY_NAMES[providerId];
}

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
  if (state.authPending && auth.status === "unknown") {
    return { text: "Checking account…", tone: "muted", title: null };
  }
  if (auth.status === "authenticated") {
    return {
      text: auth.label ?? "Signed in",
      tone: "good",
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

function ProviderRow(props: {
  readonly tourProvider: {
    readonly id: ProviderId;
    readonly harnessId: GuiHarnessId;
  };
  readonly state: ProviderCliState | undefined;
  readonly hostUnavailable: boolean;
  readonly enabledProviderCount: number;
  readonly isSettingEnabled: boolean;
  readonly onSetEnabled: (providerId: ProviderId, enabled: boolean) => void;
}) {
  const {
    tourProvider,
    state,
    hostUnavailable,
    enabledProviderCount,
    isSettingEnabled,
    onSetEnabled,
  } = props;
  const enabled = state?.enabled ?? false;
  const traycerProvider = tourProvider.id === "traycer";
  const installState = traycerProvider ? "detected" : installStateFor(state);
  const account = state === undefined ? null : accountLineFor(state);
  const dim = state !== undefined && !enabled;
  const installLabel = installLabelFor(
    traycerProvider,
    hostUnavailable,
    installState,
  );
  const installDetected =
    traycerProvider || (!hostUnavailable && installState === "detected");
  const disablingLastEnabled =
    state !== undefined && enabled && enabledProviderCount <= 1;
  const name = providerDisplayName(tourProvider.id);

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <HarnessIcon
          harnessId={tourProvider.harnessId}
          className={cn("size-4", dim ? "text-white/35" : "text-white/85")}
        />
        <span
          className={cn("text-ui-sm", dim ? "text-white/40" : "text-white/85")}
        >
          {name}
        </span>
        <span
          className={cn(
            "font-mono text-overline uppercase tracking-wider",
            installDetected ? "text-[#7fd6a4]" : "text-white/40",
          )}
        >
          {installLabel}
        </span>
        {state !== undefined ? (
          <ProviderEnableSwitch
            providerId={state.providerId}
            name={name}
            enabled={enabled}
            disablingLastEnabled={disablingLastEnabled}
            isSettingEnabled={isSettingEnabled}
            onSetEnabled={onSetEnabled}
          />
        ) : null}
      </div>
      {account !== null ? (
        <p
          title={account.title ?? undefined}
          className="min-w-0 truncate pl-[1.625rem] text-ui-xs text-white/45"
        >
          {account.text}
        </p>
      ) : null}
    </li>
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

  return (
    <ul aria-label="Coding agent CLIs" className="flex flex-col gap-2.5">
      {TOUR_PROVIDERS.map((tourProvider) => (
        <ProviderRow
          key={tourProvider.id}
          tourProvider={tourProvider}
          state={providers?.find(
            (provider) => provider.providerId === tourProvider.id,
          )}
          hostUnavailable={hostUnavailable}
          enabledProviderCount={enabledProviderCount}
          isSettingEnabled={setEnabled.isPending}
          onSetEnabled={handleSetEnabled}
        />
      ))}
    </ul>
  );
}
