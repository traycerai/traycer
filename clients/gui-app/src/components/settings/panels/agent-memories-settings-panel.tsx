import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConfigAgentMemoriesResponse } from "@traycer/protocol/host/config/schemas";
import { Switch } from "@/components/ui/switch";
import {
  agentMemoryWriteProgress,
  type AgentMemoryWriteProgress,
} from "@/components/settings/panels/agent-memories-write-progress";
import { AGENT_MEMORIES } from "@/components/settings/panels/agent-memories.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import { configMutationKeys } from "@/lib/query-keys";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { configurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentAgentMemoriesQuery } from "@/hooks/environment/team/use-agent-memories-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { ConfigurationReadFailed } from "@/components/settings/environment/team-read-failed";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";

const AGENT_MEMORIES_GET = "config.agentMemories.get";
const AGENT_MEMORIES_SET = "config.agentMemories.set";

/**
 * Settings ▸ Agent memories: whether the configuration's agents are shown its
 * shared memories and keep them current.
 *
 * The memories belong to the configuration, not to a computer, so the switch
 * is read and written where the rest of the configuration is - from the
 * configuration itself on its own pages, and from the window's host otherwise
 * (`EnvironmentHostBinding` re-provides the binding `useHostClient()` names).
 * Personal and a team are separate configurations and so are separate
 * answers; nothing here can reach across them.
 */
export function AgentMemoriesSettingsPanel(): ReactNode {
  const source = useConfigurationSource();
  const personal = useConfigurationIsPersonal();
  const teamName =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const hostId = useAddressableHostId();
  // BOTH methods, because they negotiate independently: the row is an
  // interactive switch, so a host that could answer `get` but not `set` would
  // render a control whose every flip fails. Two statements, not one `&&`:
  // short-circuiting a hook call is a rules-of-hooks violation.
  const getSupported = useHostMethodSupport(hostId, AGENT_MEMORIES_GET);
  const setSupported = useHostMethodSupport(hostId, AGENT_MEMORIES_SET);
  const supported =
    getSupported === null || setSupported === null
      ? null
      : getSupported && setSupported;

  return (
    <SettingsPanelShell
      title="Agent memories"
      description={
        source.kind === "pool" && !personal
          ? `What ${teamName}'s agents carry from one task to the next, on every host running ${teamName}.`
          : "What your agents carry from one task to the next, on every computer and sandbox running this configuration."
      }
      bodyClassName="flex flex-col gap-3 overflow-visible rounded-none border-none bg-transparent"
    >
      {/* No group heading: the page has one row, and the group's title would
          only repeat the page's own. */}
      <SettingsGroup
        group={AGENT_MEMORIES.definitions.memories}
        showTitle={false}
        tone="default"
        dataTestId="settings-agent-memories"
        fill={false}
      >
        {source.kind === "pool" ? (
          <TeamAgentMemoriesRow />
        ) : (
          <HostAgentMemoriesRow supported={supported} />
        )}
      </SettingsGroup>
    </SettingsPanelShell>
  );
}

function HostAgentMemoriesRow(props: {
  readonly supported: boolean | null;
}): ReactNode {
  if (props.supported === true) return <AgentMemoriesRow />;
  return (
    <SettingsRow
      row={AGENT_MEMORIES.definitions.useTraycerMemories}
      status={
        props.supported === false
          ? "Update this host to change this setting."
          : undefined
      }
      control={
        <Switch
          checked={false}
          disabled
          aria-label="Use Traycer memories for agents"
        />
      }
    />
  );
}

const SETTING_STATUS = `${AGENT_MEMORIES.definitions.useTraycerMemories.description} Running agents pick this up on their next turn.`;

/**
 * How long the row keeps re-reading for a write it has not been able to place.
 * Past it the row says the change was not confirmed here and stops asking: a
 * host whose delta never comes would otherwise be re-read for ever, and the
 * extra reads promise the person nothing the line does not already say.
 */
export const AGENT_MEMORY_CONFIRM_BOUND_MS = 60_000;

/** The line under the host row, in the order the person needs it. */
function hostRowStatus(input: {
  readonly readFailed: boolean;
  readonly progress: AgentMemoryWriteProgress;
}): string {
  if (input.readFailed)
    return "Couldn't read this host's agent memories setting. Check the host connection and reopen Settings.";
  switch (input.progress.kind) {
    case "queued":
      return "Waiting to reach your configuration. This computer will send the change when it is online.";
    case "waiting":
      return "Saved to your configuration. This host hasn't picked it up yet; it will when it does.";
    case "unconfirmed":
      return "Whether this change took effect can't be shown here. Reopen Settings to read it again.";
    case "refused":
      return "Your configuration refused this change. Reopen Settings to read what it holds.";
    case "stale":
      return "Someone else changed this setting first. Reopen Settings to read what your configuration holds.";
    case "failed":
      // Deliberately says nothing about whether it was saved. A refusal from
      // the configuration and a reply that never arrived are the same code
      // here, so naming either would be a guess.
      return "Couldn't change this setting. Reopen Settings to read what your configuration holds.";
    case "settled":
      return SETTING_STATUS;
  }
}

/**
 * Rendered ONLY under a positive `useHostMethodSupport` for both the getter
 * and the setter, which is what makes `useHostClient()` safe here: a host that
 * advertised the methods has a binding.
 */
function AgentMemoriesRow(): ReactNode {
  const client = useHostClient();
  const setEnabled = useHostScopedMutationForClient(client, {
    method: AGENT_MEMORIES_SET,
    mutationKey: configMutationKeys.agentMemoriesSet(),
    errorMessage: "Couldn't update agent memories",
    invalidateMethods: [],
  });
  const query = useHostQuery<HostRpcRegistry, "config.agentMemories.get">({
    cacheKeyIdentity: undefined,
    client,
    method: AGENT_MEMORIES_GET,
    params: {},
    options: { enabled: true },
  });
  const hostId = client.getActiveHostId();
  const [observation, setObservation] = useState<{
    readonly hostId: string | null;
    readonly read: ConfigAgentMemoriesResponse | undefined;
    readonly progress: AgentMemoryWriteProgress;
  } | null>(null);
  const observer = useRef<{ stop: () => void } | null>(null);
  useEffect(
    () => () => {
      observer.current?.stop();
      observer.current = null;
    },
    [client],
  );
  const shown = observation?.hostId === hostId ? observation : null;
  const read = shown?.read ?? query.data;

  function submit(asked: boolean): void {
    observer.current?.stop();
    const controller = new AbortController();
    const expiresAt = Date.now() + AGENT_MEMORY_CONFIRM_BOUND_MS;
    const environmentId = read?.environmentId ?? null;
    let timer: number | null = null;
    let deadline: number | null = null;
    let latestRead = read;
    function stop(): void {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
      if (deadline !== null) window.clearTimeout(deadline);
    }
    const current = { stop };
    observer.current = current;
    function live(): boolean {
      return (
        observer.current === current &&
        !controller.signal.aborted &&
        client.getActiveHostId() === hostId &&
        Date.now() < expiresAt
      );
    }
    function show(progress: AgentMemoryWriteProgress): void {
      setObservation({ hostId, read: latestRead, progress });
    }
    function finish(progress: AgentMemoryWriteProgress): void {
      show(progress);
      stop();
      if (observer.current === current) observer.current = null;
    }
    show({ kind: "settled" });
    // Armed at submission, independently of mutation and read completion.
    deadline = window.setTimeout(() => {
      if (observer.current !== current) return;
      finish({ kind: "unconfirmed" });
    }, AGENT_MEMORY_CONFIRM_BOUND_MS);
    setEnabled.mutate(
      { enabled: asked },
      {
        onError: (error) => {
          if (!live()) return;
          finish({
            kind: error.code === "ENVIRONMENT_WRITE_STALE" ? "stale" : "failed",
          });
        },
        onSuccess: (response) => {
          if (!live()) return;
          if (
            environmentId !== null &&
            response.environmentId !== environmentId
          ) {
            finish({ kind: "settled" });
            return;
          }
          let answer = response;
          if (answer.state === "applied") {
            latestRead = {
              enabled: answer.enabled,
              revision: answer.revision,
              environmentId: answer.environmentId,
            };
            finish({ kind: "settled" });
            return;
          }
          if (answer.state === "saved" && answer.revision === null) {
            finish({ kind: "unconfirmed" });
            return;
          }
          show({ kind: answer.state === "queued" ? "queued" : "waiting" });
          async function tick(): Promise<void> {
            if (!live()) return;
            try {
              latestRead = await client.requestWithSignal(
                AGENT_MEMORIES_GET,
                {},
                controller.signal,
              );
              if (!live()) return;
              if (
                latestRead.environmentId !== null &&
                latestRead.environmentId !== answer.environmentId
              ) {
                finish({ kind: "settled" });
                return;
              }
              let queue;
              if (answer.state === "queued") {
                queue =
                  await client.requestWithSignalRequiringHostMethodVersion(
                    "environment.status",
                    {},
                    controller.signal,
                    {
                      method: "environment.status",
                      version: { major: 1, minor: 1 },
                    },
                  );
                if (!live()) return;
                // The host can rebind during the status request. Read the binding
                // again before accepting its receipt against the previous snapshot.
                latestRead = await client.requestWithSignal(
                  AGENT_MEMORIES_GET,
                  {},
                  controller.signal,
                );
                if (!live()) return;
                if (
                  latestRead.environmentId !== null &&
                  latestRead.environmentId !== answer.environmentId
                ) {
                  finish({ kind: "settled" });
                  return;
                }
                const receipt = queue.acceptedUploads.find(
                  (entry) =>
                    entry.uploadId === answer.uploadId &&
                    entry.environmentId === answer.environmentId &&
                    entry.kind === "agent_memory" &&
                    entry.key === "memory" &&
                    entry.os === "any",
                );
                // Keep the saved floor even if a later status omits this witness.
                if (receipt !== undefined)
                  answer = {
                    ...answer,
                    state: "saved",
                    revision: receipt.revision,
                  };
              }
              const progress = agentMemoryWriteProgress({
                answer,
                asked,
                read: latestRead,
                queue,
              });
              if (progress.kind !== "waiting" && progress.kind !== "queued") {
                finish(progress);
                return;
              }
              show(progress);
            } catch {
              // A failed read is unavailable evidence, not a write refusal.
              if (!live()) return;
            }
            if (live())
              timer = window.setTimeout(() => {
                void tick();
              }, 5_000);
          }
          void tick();
        },
      },
    );
  }

  return (
    <SettingsRow
      row={AGENT_MEMORIES.definitions.useTraycerMemories}
      status={hostRowStatus({
        readFailed: query.isError,
        progress: shown?.progress ?? { kind: "settled" },
      })}
      control={
        <Switch
          checked={read?.enabled === true}
          disabled={query.isPending || query.isError || setEnabled.isPending}
          aria-label="Use Traycer memories for agents"
          onCheckedChange={(next) => {
            trackSettingChanged("agent-memories", "useTraycerMemories");
            submit(next);
          }}
        />
      }
    />
  );
}

/**
 * A configuration's own page. Editing follows the configuration's own
 * authority: a viewer reads the state as text, and everyone the
 * configuration lets write items may flip it.
 */
function TeamAgentMemoriesRow(): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const query = useEnvironmentAgentMemoriesQuery(false);
  const read = useBoundedRead(query);
  const { put } = useConfigurationItemMutations();
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  let control: ReactNode = null;
  if (read.pending)
    control = <span className="text-ui-xs text-muted-foreground">Loading</span>;
  else if (query.data !== undefined) {
    const data = query.data;
    control = canEdit ? (
      <Switch
        checked={data.enabled}
        disabled={put.isPending}
        aria-label="Use Traycer memories for agents"
        onCheckedChange={(enabled) => {
          if (source.kind !== "pool") return;
          put.mutate({
            environmentId: source.environmentId,
            kind: "agent_memory",
            key: "memory",
            os: null,
            value: { enabled },
            revision: data.revision,
          });
        }}
      />
    ) : (
      <span className="text-ui-sm text-muted-foreground">
        {data.enabled ? "On" : "Off"}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SettingsRow
        row={AGENT_MEMORIES.definitions.useTraycerMemories}
        status={
          read.failed ? (
            <ConfigurationReadFailed
              page="agent memories"
              onRetry={read.retry}
            />
          ) : (
            SETTING_STATUS
          )
        }
        control={control}
      />
      <ConfigurationWriteFeedback issue={issue} />
    </div>
  );
}
