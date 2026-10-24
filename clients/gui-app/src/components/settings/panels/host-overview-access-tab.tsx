/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Access and setup).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Circle } from "lucide-react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentStatusResponseV11,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import {
  isProfileEnabled,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  LOCAL_VALUES_RESTART_NOTE,
  localOverrideLabel,
  MOVED_NOTICE_TEXT,
  movedNoticeShown,
  SETUP_STEPS,
  setupView,
  TERMINAL_ACCOUNT_SENTENCE,
  type SetupView,
} from "@/components/settings/host-scope/host-access-model";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import { RemoteAccessSection } from "@/components/settings/host-scope/remote-access-section";
import { TeamOwnedLine } from "@/components/settings/host-scope/team-owned-line";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import { HostOverviewSettingsCard } from "@/components/settings/panels/host-overview-settings-card";
import { SettingsGroup } from "@/components/settings/settings-group";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import {
  useEnvironmentLocalOverridesRead,
  useEnvironmentNoticesRead,
  useEnvironmentStatusRead,
} from "@/hooks/environment/use-environment-reads";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSetProfileEnabledForClient } from "@/hooks/providers/use-providers-set-profile-enabled-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { providerDisplayName } from "@/lib/provider-ordering";
import { environmentMutationKeys } from "@/lib/query-keys";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

/**
 * Overview ▸ Access and setup: the picked host's own access and setup, read
 * through that host. Whether other devices and agents can reach it, how far
 * its first start got, its own sign-ins, and the values kept on it only.
 * A team's host shows them read-only under the team's name.
 */
export interface HostOverviewAccessTabProps {
  /** The scope's own client; `null` while the scope cannot reach the host. */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  /** Connecting the scope, or waiting for an expected host restart. */
  readonly connecting: boolean;
  /** Whether the scope can reach the host, and so whether a read may mount. */
  readonly usable: boolean;
}

export function HostOverviewAccessTab(
  props: HostOverviewAccessTabProps,
): ReactNode {
  if (props.connecting) {
    return (
      <HostOverviewTabSections>
        <HostScopeConnecting hostName={props.hostName} />
      </HostOverviewTabSections>
    );
  }
  if (!props.usable || props.client === null) {
    return (
      <HostOverviewTabSections>
        <p className="text-ui-sm text-muted-foreground">
          These are {props.hostName}'s own, so they need a connection to it.
        </p>
      </HostOverviewTabSections>
    );
  }
  return (
    <HostOverviewTabSections>
      <AccessTabBody
        client={props.client}
        hostId={props.hostId}
        hostName={props.hostName}
      />
    </HostOverviewTabSections>
  );
}

function AccessTabBody(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly hostName: string;
}): ReactNode {
  const status = useEnvironmentStatusRead(props.client, props.hostId, true);
  if (status.supported === false) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="access-tab-update-host"
      >
        Update this host to use your settings.
      </p>
    );
  }
  if (status.data === null) {
    return status.isError ? (
      <p className="text-ui-sm text-muted-foreground">
        Couldn't read this host's access and setup.
      </p>
    ) : (
      <AgentSpinningDots
        className={undefined}
        testId="access-tab-loading"
        variant={undefined}
        tone="muted"
      />
    );
  }
  const { principal } = status.data;
  const sections = (
    <AccessSections
      client={props.client}
      hostId={props.hostId}
      hostName={props.hostName}
      status={status.data}
    />
  );
  if (principal?.kind !== "team") return sections;
  return (
    <>
      <TeamOwnedLine teamName={principal.teamName} />
      <div inert className="flex flex-col gap-5 opacity-60">
        {sections}
      </div>
    </>
  );
}

function AccessSections(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly status: EnvironmentStatusResponseV11;
}): ReactNode {
  const { hostId } = props;
  return (
    <>
      {hostId === null ? null : (
        <HostOverviewSettingsCard
          client={props.client}
          hostId={hostId}
          hostName={props.hostName}
          status={props.status}
        />
      )}
      <MovedNotice
        client={props.client}
        hostId={props.hostId}
        status={props.status}
      />
      <SetupSection
        client={props.client}
        hostId={props.hostId}
        view={setupView(props.status.setup)}
      />
      <RemoteAccessSection
        client={props.client}
        hostId={props.hostId}
        status={props.status.remoteAccess}
      />
      <TerminalAccountsSection client={props.client} />
      <LocalValuesSection client={props.client} hostId={props.hostId} />
    </>
  );
}

// ── "Your settings moved to Personal" ───────────────────────────────────────

function MovedNotice(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly status: EnvironmentStatusResponseV11;
}): ReactNode {
  const setupDone =
    props.status.setup !== null &&
    (props.status.setup.state === "done" ||
      props.status.setup.stage === "done");
  const notices = useEnvironmentNoticesRead(
    props.client,
    props.hostId,
    setupDone && props.status.principal?.kind === "personal",
  );
  const dismissed = useHostAccessPromptsStore((state) =>
    props.hostId === null
      ? true
      : state.movedNoticeDismissed[props.hostId] === true,
  );
  const dismiss = useHostAccessPromptsStore(
    (state) => state.dismissMovedNotice,
  );
  if (
    props.hostId === null ||
    !movedNoticeShown(props.status, notices.data?.notices ?? [], dismissed)
  ) {
    return null;
  }
  const hostId = props.hostId;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-ui-sm text-info-foreground"
      data-testid="moved-to-personal-notice"
    >
      <span className="min-w-0">{MOVED_NOTICE_TEXT}</span>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => dismiss(hostId)}
        >
          Dismiss
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="moved-to-personal-review-link"
          onClick={() => {
            navigateToSettingsSection("secrets");
          }}
        >
          Review
        </Button>
      </div>
    </div>
  );
}

// ── Setup ────────────────────────────────────────────────────────────────────

function SetupSection(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly view: SetupView | null;
}): ReactNode {
  const retryable =
    useHostMethodSupport(props.hostId, "environment.setup.retry") === true;
  const retry = useHostScopedMutationForClient(props.client, {
    method: "environment.setup.retry",
    mutationKey: environmentMutationKeys.setupRetry(),
    errorMessage: "Couldn't retry setup.",
    invalidateMethods: ["environment.status", "environment.setup.attempts"],
  });
  const { view } = props;
  if (view === null) return null;
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.hostSetup}
      showTitle
      tone="default"
      dataTestId="host-setup-section"
      fill={false}
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <ol className="flex flex-col gap-1.5" aria-label="Setup steps">
          {SETUP_STEPS.map((step, index) => (
            <SetupStepRow
              key={step.stage}
              label={step.label}
              mark={setupStepMark(view, index)}
            />
          ))}
        </ol>
        {view.kind === "running" && view.stepIndex !== -1 ? (
          <p className="text-ui-xs text-muted-foreground">
            Step {view.stepIndex + 1} of {SETUP_STEPS.length}
          </p>
        ) : null}
        {view.kind === "stopped" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              className="text-ui-sm text-warning-foreground"
              data-testid="host-setup-stopped"
            >
              {view.text}
            </p>
            {retryable ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={retry.isPending}
                onClick={() => retry.mutate({})}
              >
                Retry
                {retry.isPending ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId={undefined}
                    variant={undefined}
                    tone="muted"
                  />
                ) : null}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

type SetupStepMark = "done" | "running" | "stopped" | "waiting";

function setupStepMark(view: SetupView, index: number): SetupStepMark {
  if (view.stepIndex === -1) return "waiting";
  if (index < view.stepIndex) return "done";
  if (index > view.stepIndex) return "waiting";
  return view.kind === "running" ? "running" : "stopped";
}

function SetupStepRow(props: {
  readonly label: string;
  readonly mark: SetupStepMark;
}): ReactNode {
  return (
    <li
      className={cn(
        "flex items-center gap-2 text-ui-sm",
        props.mark === "waiting" ? "text-muted-foreground" : "text-foreground",
      )}
      data-testid="host-setup-step"
      data-mark={props.mark}
    >
      <SetupStepIcon mark={props.mark} />
      <span className="min-w-0">{props.label}</span>
    </li>
  );
}

function SetupStepIcon(props: { readonly mark: SetupStepMark }): ReactNode {
  switch (props.mark) {
    case "done":
      return <Check className="size-3.5 shrink-0 text-success" aria-hidden />;
    case "running":
      return (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      );
    case "stopped":
      return (
        <AlertTriangle
          className="size-3.5 shrink-0 text-warning-foreground"
          aria-hidden
        />
      );
    case "waiting":
      return <Circle className="size-3.5 shrink-0" aria-hidden />;
  }
}

// ── Terminal account ─────────────────────────────────────────────────────────

/** The ambient profile: the sign-in a provider's own CLI has on this computer. */
const AMBIENT_PROFILE_ID = "ambient";

function TerminalAccountsSection(props: {
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  const list = useProvidersListForClient(props.client, {
    enabled: true,
    subscribed: true,
  });
  const rows = (list.data?.providers ?? []).flatMap((provider) => {
    const ambient = provider.profiles.find(
      (profile) => profile.kind === "ambient",
    );
    return ambient === undefined
      ? []
      : [
          {
            providerId: provider.providerId,
            enabled: isProfileEnabled(ambient),
          },
        ];
  });
  if (rows.length === 0) return null;
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.terminalAccounts}
      showTitle
      tone="default"
      dataTestId="terminal-accounts-section"
      fill={false}
    >
      <p className="max-w-[72ch] px-5 pt-4 text-ui-sm text-muted-foreground">
        {TERMINAL_ACCOUNT_SENTENCE}
      </p>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <TerminalAccountRow
            key={row.providerId}
            client={props.client}
            providerId={row.providerId}
            enabled={row.enabled}
          />
        ))}
      </ul>
    </SettingsGroup>
  );
}

function TerminalAccountRow(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly providerId: ProviderId;
  readonly enabled: boolean;
}): ReactNode {
  const setEnabled = useProvidersSetProfileEnabledForClient(
    props.client,
    props.providerId,
  );
  const name = providerDisplayName(props.providerId);
  return (
    <li
      className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-3 last:border-b-0"
      data-testid="terminal-account-row"
    >
      <div className="min-w-0">
        <div className="font-medium text-foreground">{name}</div>
        <div className="text-ui-xs text-muted-foreground">Terminal account</div>
      </div>
      <Switch
        checked={props.enabled}
        disabled={setEnabled.isPending}
        aria-label={`${name} Terminal account`}
        onCheckedChange={(enabled) =>
          setEnabled.mutate({
            providerId: props.providerId,
            profileId: AMBIENT_PROFILE_ID,
            enabled,
          })
        }
      />
    </li>
  );
}

// ── This host's own values ───────────────────────────────────────────────────

/** Set and clear for one value go to the host in the order they were made. */
const LOCAL_OVERRIDE_SCOPE = { id: "config.env.localOverride" } as const;

/** What a kept value's change reaches: the list here and the pages showing it. */
const LOCAL_OVERRIDE_READS = [
  "environment.localOverrides",
  "config.env.list",
  "providers.list",
] as const;

function LocalValuesSection(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
}): ReactNode {
  const overrides = useEnvironmentLocalOverridesRead(
    props.client,
    props.hostId,
    true,
  );
  if (overrides.supported !== true) return null;
  const list = overrides.data?.overrides ?? [];
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.localValues}
      showTitle
      tone="default"
      dataTestId="local-values-section"
      fill={false}
    >
      <p className="max-w-[72ch] px-5 pt-4 text-ui-sm text-muted-foreground">
        {LOCAL_VALUES_RESTART_NOTE}
      </p>
      {list.length === 0 ? (
        <p className="px-5 py-4 text-ui-sm text-muted-foreground">
          {overrides.isError
            ? "Couldn't read the values kept on this host."
            : "No values are kept on this host only."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {list.map((override) => (
            <LocalValueRow
              key={localValueKey(override)}
              client={props.client}
              override={override}
            />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

function localValueKey(override: LocalOverride): string {
  const { target } = override;
  return target.kind === "variable"
    ? `variable:${target.key}:${override.os}`
    : `env_override:${target.providerId}:${target.key}:${override.os}`;
}

function LocalValueRow(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly override: LocalOverride;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const grant = useExecutableWriteGrant();
  const set = useHostScopedMutationForClient(props.client, {
    method: "config.env.localOverride.set",
    // The value can select what starts, so it carries the grant.
    prepareRequest: grant,
    mutationKey: environmentMutationKeys.localOverrideSet(),
    errorMessage: "Couldn't save the value.",
    scope: LOCAL_OVERRIDE_SCOPE,
    invalidateMethods: LOCAL_OVERRIDE_READS,
    onSuccess: (data) => {
      if (data.outcome === "needs_grant") {
        toast.error("Couldn't save the value without your confirmation.");
        return;
      }
      setDraft(null);
    },
  });
  const clear = useHostScopedMutationForClient(props.client, {
    method: "config.env.localOverride.clear",
    mutationKey: environmentMutationKeys.localOverrideClear(),
    errorMessage: "Couldn't clear the value.",
    scope: LOCAL_OVERRIDE_SCOPE,
    invalidateMethods: LOCAL_OVERRIDE_READS,
  });
  const label = localOverrideLabel(props.override);
  const pending = set.isPending || clear.isPending;
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/40 px-5 py-3 last:border-b-0"
      data-testid="local-value-row"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{label}</div>
        {draft === null ? (
          <div className="break-all font-mono text-ui-xs text-muted-foreground">
            {props.override.value}
          </div>
        ) : (
          <Input
            aria-label={`${label} value on this host`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {draft === null ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setDraft(props.override.value)}
            >
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => clear.mutate({ target: props.override.target })}
            >
              Clear
              {clear.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                  tone="muted"
                />
              ) : null}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || draft === props.override.value}
              onClick={() =>
                set.mutate({
                  target: props.override.target,
                  value: draft,
                  executableWriteGrant: null,
                })
              }
            >
              Save
              {set.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                  tone="muted"
                />
              ) : null}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
