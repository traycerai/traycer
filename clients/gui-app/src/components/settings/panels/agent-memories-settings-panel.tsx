import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ConfigAgentMemoriesResponse } from "@traycer/protocol/host/config/schemas";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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
import {
  hostClientUnavailableError,
  useHostQuery,
  useHostQueryEntryHash,
  useHostQueryWithResponseMap,
} from "@/hooks/host/use-host-query";
import { readHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
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

interface ConfirmationSnapshot<T> {
  readonly response: T;
  readonly attempt: symbol | null | undefined;
}

/** Reverted cancellation can return old data; only this attempt can confirm. */
function confirmationData<T>(
  snapshot: ConfirmationSnapshot<T> | undefined,
  attempt: symbol,
  method: string,
): T {
  if (snapshot === undefined || snapshot.attempt !== attempt)
    throw hostClientUnavailableError(method);
  return snapshot.response;
}

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
      row={AGENT_MEMORIES.definitions.traycerMemories}
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

const SETTING_STATUS = `${AGENT_MEMORIES.definitions.traycerMemories.description} Running agents pick this up on their next turn.`;

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
  const queryClient = useQueryClient();
  const entryHash = useHostQueryEntryHash({
    cacheKeyIdentity: undefined,
    client,
    method: AGENT_MEMORIES_GET,
    params: {},
  });
  const setEnabled = useHostScopedMutationForClient(client, {
    method: AGENT_MEMORIES_SET,
    mutationKey: configMutationKeys.agentMemoriesSet(),
    errorMessage: "Couldn't update agent memories",
    // The observer owns sequential confirmation reads. Mark this exact entry
    // stale without launching a parallel fetch; reopening before confirmation
    // must re-read even inside the normal cache freshness window.
    invalidateMethods: [],
    captureContext: () => entryHash,
    onSettled: (_hostId, capturedEntryHash) => {
      // Cancel first: an older GET could otherwise clear this invalidation
      // after an uncertain write, or restore its pre-fetch snapshot on unmount.
      void queryClient.cancelQueries({
        predicate: (entry) => entry.queryHash === capturedEntryHash,
      });
      void queryClient.invalidateQueries({
        predicate: (entry) => entry.queryHash === capturedEntryHash,
        refetchType: "none",
      });
    },
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
    readonly client: HostClient<HostRpcRegistry>;
    readonly hostId: string | null;
    readonly queryRead: ConfigAgentMemoriesResponse | undefined;
    readonly active: boolean;
    readonly read: ConfigAgentMemoriesResponse | undefined;
    readonly progress: AgentMemoryWriteProgress;
  } | null>(null);
  const observer = useRef<{
    readonly client: HostClient<HostRpcRegistry>;
    readonly live: () => boolean;
    readonly stop: () => void;
  } | null>(null);
  // Confirmation snapshots are isolated from the canonical getter until the
  // receipt and revision floor establish that this write has been applied.
  const confirmationId = useId();
  const confirmationIdentity = ["agent-memory-confirmation", confirmationId];
  function preflightConfirmation(method: string): void {
    const current = observer.current;
    if (
      current?.client !== client ||
      !current.live() ||
      !readHostReadiness(client).canExecute
    )
      throw hostClientUnavailableError(method);
  }
  const readAttempt = useRef<symbol | null>(null);
  const statusAttempt = useRef<symbol | null>(null);
  const confirmationRead = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "config.agentMemories.get",
    ConfirmationSnapshot<ConfigAgentMemoriesResponse>,
    symbol | null
  >({
    cacheKeyIdentity: confirmationIdentity,
    client,
    method: AGENT_MEMORIES_GET,
    params: {},
    options: { enabled: false, poll: false, gcTime: 0, retry: false },
    preflight: () => preflightConfirmation(AGENT_MEMORIES_GET),
    captureRequestContext: () => readAttempt.current,
    mapResponse: ({ response, requestContext }) => ({
      response,
      attempt: requestContext,
    }),
  });
  const confirmationStatus = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "environment.status",
    ConfirmationSnapshot<EnvironmentStatusResponseV12>,
    symbol | null
  >({
    cacheKeyIdentity: confirmationIdentity,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: false, poll: false, gcTime: 0 },
    preflight: () => preflightConfirmation("environment.status"),
    captureRequestContext: () => statusAttempt.current,
    mapResponse: ({ response, requestContext }) => ({
      response,
      attempt: requestContext,
    }),
  });
  const confirmationReadHash = useHostQueryEntryHash({
    cacheKeyIdentity: confirmationIdentity,
    client,
    method: AGENT_MEMORIES_GET,
    params: {},
  });
  const confirmationStatusHash = useHostQueryEntryHash({
    cacheKeyIdentity: confirmationIdentity,
    client,
    method: "environment.status",
    params: {},
  });
  useEffect(
    () => () => {
      observer.current?.stop();
      observer.current = null;
    },
    [client],
  );
  // Replacing the requester retires its observation, even for the same host.
  // A terminal observation bridges the cached read from before submission.
  // Once the real query receives another snapshot it owns the row again.
  const shown =
    observation?.client === client &&
    observation.hostId === hostId &&
    (observation.active || observation.queryRead === query.data)
      ? observation
      : null;
  const read = shown?.read ?? query.data;

  function submit(asked: boolean): void {
    observer.current?.stop();
    const controller = new AbortController();
    const expiresAt = Date.now() + AGENT_MEMORY_CONFIRM_BOUND_MS;
    const environmentId = read?.environmentId ?? null;
    let timer: number | null = null;
    let deadline: number | null = null;
    let latestRead = read;
    let queryRead = query.data;
    let publishedConfirmation = false;
    function cacheRead(): void {
      const capturedEntry = {
        predicate: (cached: { queryHash: string }) =>
          cached.queryHash === entryHash,
      };
      const canonicalRead = queryClient
        .getQueriesData<ConfigAgentMemoriesResponse>(capturedEntry)
        .at(0)?.[1];
      // A changed query owns its environment and equal/newer revision. A
      // confirmed newer revision of that same environment can still advance it.
      if (
        canonicalRead !== queryRead &&
        !(
          latestRead?.environmentId !== null &&
          latestRead?.environmentId !== undefined &&
          canonicalRead?.environmentId === latestRead.environmentId &&
          canonicalRead.revision !== null &&
          latestRead.revision !== null &&
          canonicalRead.revision < latestRead.revision
        )
      )
        return;
      // Fence a GET started before confirmation: cancellation happens
      // synchronously, so its eventual response cannot overwrite this snapshot.
      void queryClient.cancelQueries(capturedEntry);
      const entries = queryClient.setQueriesData<ConfigAgentMemoriesResponse>(
        capturedEntry,
        latestRead,
      );
      queryRead = entries.at(0)?.[1] ?? queryRead;
      publishedConfirmation = true;
    }
    function stop(): void {
      controller.abort();
      void queryClient.cancelQueries({
        predicate: (entry) =>
          entry.queryHash === confirmationReadHash ||
          entry.queryHash === confirmationStatusHash,
      });
      if (timer !== null) window.clearTimeout(timer);
      if (deadline !== null) window.clearTimeout(deadline);
      if (!publishedConfirmation) {
        const capturedEntry = {
          predicate: (cached: { queryHash: string }) =>
            cached.queryHash === entryHash,
        };
        // A focus read can freshen the old projection after settlement. Leave
        // unconfirmed observations stale on departure or expiry, fencing any
        // in-flight read before invalidation so it cannot restore freshness.
        void queryClient.cancelQueries(capturedEntry);
        void queryClient.invalidateQueries({
          ...capturedEntry,
          refetchType: "none",
        });
      }
    }
    const current = { client, live, stop };
    observer.current = current;
    function live(): boolean {
      return (
        observer.current === current &&
        !controller.signal.aborted &&
        client.getActiveHostId() === hostId &&
        Date.now() < expiresAt
      );
    }
    function show(progress: AgentMemoryWriteProgress, active: boolean): void {
      setObservation({
        client,
        hostId,
        queryRead,
        active,
        read: latestRead,
        progress,
      });
    }
    function finish(progress: AgentMemoryWriteProgress): void {
      show(progress, false);
      stop();
      if (observer.current === current) observer.current = null;
    }
    function finishAfterRead(progress: AgentMemoryWriteProgress): void {
      if (progress.kind === "settled") cacheRead();
      finish(progress);
    }
    show({ kind: "settled" }, true);
    // Armed at submission, independently of mutation and read completion.
    deadline = window.setTimeout(() => {
      if (observer.current !== current) return;
      finish({ kind: "unconfirmed" });
    }, AGENT_MEMORY_CONFIRM_BOUND_MS);
    setEnabled.mutate(
      { enabled: asked },
      {
        onError: () => {
          if (!live()) return;
          // The shared mutation reports setter failures, including after this
          // row unmounts. Retire the observation without repeating that notice.
          finish({ kind: "settled" });
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
            finishAfterRead({ kind: "settled" });
            return;
          }
          if (answer.state === "saved" && answer.revision === null) {
            finish({ kind: "unconfirmed" });
            return;
          }
          show(
            { kind: answer.state === "queued" ? "queued" : "waiting" },
            true,
          );
          async function tick(): Promise<void> {
            if (!live()) return;
            try {
              const initialAttempt = Symbol();
              readAttempt.current = initialAttempt;
              latestRead = confirmationData(
                (await confirmationRead.refetch({ throwOnError: true })).data,
                initialAttempt,
                AGENT_MEMORIES_GET,
              );
              if (!live()) return;
              if (
                latestRead.environmentId !== null &&
                latestRead.environmentId !== answer.environmentId
              ) {
                finishAfterRead({ kind: "settled" });
                return;
              }
              let queue;
              if (answer.state === "queued") {
                const receiptAttempt = Symbol();
                statusAttempt.current = receiptAttempt;
                queue = confirmationData(
                  (await confirmationStatus.refetch({ throwOnError: true }))
                    .data,
                  receiptAttempt,
                  "environment.status",
                );
                if (!live()) return;
                // The host can rebind during the status request. Read the binding
                // again before accepting its receipt against the previous snapshot.
                const bindingAttempt = Symbol();
                readAttempt.current = bindingAttempt;
                latestRead = confirmationData(
                  (await confirmationRead.refetch({ throwOnError: true })).data,
                  bindingAttempt,
                  AGENT_MEMORIES_GET,
                );
                if (!live()) return;
                if (
                  latestRead.environmentId !== null &&
                  latestRead.environmentId !== answer.environmentId
                ) {
                  finishAfterRead({ kind: "settled" });
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
                finishAfterRead(progress);
                return;
              }
              show(progress, true);
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
      row={AGENT_MEMORIES.definitions.traycerMemories}
      status={hostRowStatus({
        readFailed: query.isError,
        progress: shown?.progress ?? { kind: "settled" },
      })}
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={read?.enabled === true}
            disabled={query.isPending || query.isError || setEnabled.isPending}
            aria-label="Use Traycer memories for agents"
            onCheckedChange={(next) => {
              trackSettingChanged("agent-memories", "useTraycerMemories");
              submit(next);
            }}
          />
          {setEnabled.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </div>
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
      <div className="flex items-center gap-2">
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
        {put.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </div>
    ) : (
      <span className="text-ui-sm text-muted-foreground">
        {data.enabled ? "On" : "Off"}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SettingsRow
        row={AGENT_MEMORIES.definitions.traycerMemories}
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
