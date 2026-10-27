import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { v4 as uuidv4 } from "uuid";
import { useNavigate } from "@tanstack/react-router";
import type {
  SandboxAutomationOpenTarget,
  SandboxPod,
} from "@traycer/protocol/host/sandbox-control";
import {
  AutomationTerminalOpenContext,
  type AutomationTerminalOpen,
} from "./automation-terminal-open-context";
import {
  useAutomationTerminalReadinessFailed,
  type AutomationTerminalAttempt,
} from "./use-automation-terminal-readiness";
import { useFolderlessTerminalLaunch } from "@/components/epic-canvas/sidebar/use-folderless-terminal-target";
import { landingPaneAnchorDraftIds } from "@/components/home/terminal-panel/landing-pane-anchor-store";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";
import {
  adoptPlainTerminalUnary,
  capturePlainTerminalProjectionBarrier,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { focusTerminalInstance } from "@/lib/terminals/terminal-focus-registry";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
import type { PlainTerminalScope } from "@traycer/protocol/host/terminal/plain-schemas";

import { useSandboxAutomationOpen } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import { useSandboxTeamPods } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const INDEPENDENT_SCOPE: PlainTerminalScope = { kind: "independent" };

interface AutomationTerminalInput {
  readonly existing: {
    readonly hostId: string;
    readonly sandboxId: string;
    readonly awake: boolean;
  } | null;
  readonly teamEnvironmentId: string | null;
}

export function useOpenAutomationTerminal(
  input: AutomationTerminalInput,
): AutomationTerminalOpen {
  const shared = useContext(AutomationTerminalOpenContext);
  const own = useAutomationTerminalOpen(input);
  return shared !== null &&
    (input.existing === null || shared.hostId === input.existing.hostId)
    ? shared
    : own;
}

function useAutomationTerminalOpen(
  input: AutomationTerminalInput,
): AutomationTerminalOpen {
  const { existing, teamEnvironmentId } = input;
  const open = useSandboxAutomationOpen("inline");
  const { close } = useSystemTabModalActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<AutomationTerminalAttempt | null>(
    null,
  );
  const currentAttempt = useRef<AutomationTerminalAttempt | null>(null);
  const dispatched = useRef(false);
  useEffect(
    () => () => {
      currentAttempt.current = null;
    },
    [],
  );
  const podEnvironmentIds = useMemo(
    () => (teamEnvironmentId === null ? [] : [teamEnvironmentId]),
    [teamEnvironmentId],
  );
  const pods = useSandboxTeamPods(podEnvironmentIds);
  const activeAttempt =
    attempt !== null && settledForStartingAccount(attempt) ? attempt : null;
  const hostId = activeAttempt === null ? null : activeAttempt.hostId;
  const client = useHostClientForHostId(hostId);
  const readinessFailed = useAutomationTerminalReadinessFailed(activeAttempt);
  useEffect(() => {
    if (readinessFailed) currentAttempt.current = null;
  }, [readinessFailed]);
  // As in the new-terminal picker, an independent launch has no epic. The
  // directory query waits for the named host's endpoint and keeps its errors.
  const launch = useFolderlessTerminalLaunch("", hostId);
  const list = useAutomationTerminalList(client, activeAttempt);
  const create = useAutomationPlainTerminalCreate(client, hostId);
  const failed =
    open.isError ||
    readinessFailed ||
    (attempt !== null && (launch.failed || list.isError || create.isError));
  const starting =
    open.isPending ||
    (attempt !== null &&
      (!failed ||
        launch.bindings.isFetching ||
        list.isFetching ||
        create.isPending));
  const { mutateAsync: createTerminal } = create;
  useEffect(() => {
    if (
      attempt === null ||
      attempt.hostId === null ||
      currentAttempt.current !== attempt ||
      !settledForStartingAccount(attempt) ||
      failed ||
      dispatched.current ||
      launch.target === null ||
      launch.bindings.isFetching ||
      !list.isSuccess ||
      list.isFetching ||
      client?.getActiveHostId() !== attempt.hostId
    )
      return;
    dispatched.current = true;
    const scopeKey = hostQueryKeys.plainTerminals(
      attempt.hostId,
      INDEPENDENT_SCOPE,
    );
    const barrier = capturePlainTerminalProjectionBarrier(
      queryClient.getQueryData<PlainTerminalCollection>(scopeKey),
    );
    void createTerminal({
      terminalId: attempt.terminalId,
      scope: INDEPENDENT_SCOPE,
      cwd: launch.target.cwd,
      cols: 80,
      rows: 24,
    }).then(
      ({ terminal }) => {
        if (
          currentAttempt.current !== attempt ||
          !settledForStartingAccount(attempt)
        )
          return;
        queryClient.setQueryData<PlainTerminalCollection>(scopeKey, (current) =>
          adoptPlainTerminalUnary(current, terminal, barrier),
        );
        const panel = useLandingPanelStore.getState();
        const instanceId = `landing-terminal-${uuidv4()}`;
        panel.clearTerminalRequest();
        panel.addTab({
          kind: "terminal",
          instanceId,
          sessionId: terminal.record.terminalId,
          hostId: terminal.record.hostId,
          cwd: terminal.record.launch.cwd,
          name: terminalSessionTitle({
            title: terminal.record.manualTitle,
            activeProcessName: terminal.runtime.activeProcessName,
            currentCwd: terminal.record.launch.cwd,
            taskHome: null,
          }),
          titleSource:
            terminal.record.manualTitle === null ? "default" : "manual",
          hostAuthorityAcknowledged: true,
          pendingCreate: false,
        });
        panel.revealPanel({
          landingPageIds: landingPaneAnchorDraftIds(),
          everyPage: true,
          instanceId,
        });
        focusTerminalInstance(instanceId);
        currentAttempt.current = null;
        setAttempt(null);
        close();
        activateTabIntent(navigate, openNewEpicIntent(), undefined);
      },
      () => undefined,
    );
  }, [
    attempt,
    client,
    close,
    createTerminal,
    failed,
    launch.bindings.isFetching,
    launch.target,
    list.isFetching,
    list.isSuccess,
    navigate,
    queryClient,
  ]);
  const target = (): SandboxAutomationOpenTarget | null =>
    automationOpenTarget(
      attempt?.sandboxId ?? existing?.sandboxId ?? null,
      teamEnvironmentId,
      teamEnvironmentId === null ? [] : (pods.get(teamEnvironmentId) ?? []),
    );
  const run = (): void => {
    if (
      currentAttempt.current !== null &&
      (starting || currentAttempt.current !== attempt)
    )
      return;
    open.reset();
    create.reset();
    dispatched.current = false;
    const next = newAutomationTerminalAttempt(
      input,
      attempt,
      readinessFailed,
      failed,
    );
    currentAttempt.current = next;
    setAttempt(next);
    if (next.hostId !== null) {
      if (attempt?.hostId === next.hostId) {
        void launch.bindings.refetch();
        void list.refetch();
      }
      return;
    }
    void open.mutateAsync(target()).then(
      (opened) => {
        if (currentAttempt.current !== next || !settledForStartingAccount(next))
          return;
        const ready = {
          ...next,
          hostId: opened.sandbox.hostId,
          sandboxId: opened.sandbox.id,
        };
        currentAttempt.current = ready;
        setAttempt(ready);
      },
      () => undefined,
    );
  };
  // A failed sandbox row's existing Retry starts it without asking for a shell.
  const retry = (): void => {
    open.mutate(target());
  };
  return {
    run,
    retry,
    starting,
    failed: failed || attempt?.retried === true,
    hostId,
  };
}

/**
 * Personal's Automations opens with no body; a team's pod by its environment
 * and its ordinal, or the pod with headroom while the pod list is unread or
 * the pod is not created yet.
 */
function automationOpenTarget(
  sandboxId: string | null,
  teamEnvironmentId: string | null,
  pods: readonly SandboxPod[],
): SandboxAutomationOpenTarget | null {
  if (teamEnvironmentId === null) return null;
  const pod = pods.find((candidate) => candidate.sandbox.id === sandboxId);
  return { environmentId: teamEnvironmentId, ordinal: pod?.ordinal ?? null };
}

/** A fresh wire list, isolated from the authority accumulator's cache slot. */
function useAutomationTerminalList(
  client: HostClient<HostRpcRegistry> | null,
  attempt: AutomationTerminalAttempt | null,
) {
  return useHostQuery<HostRpcRegistry, "terminal.plain.list">({
    client: attempt === null || attempt.hostId === null ? null : client,
    method: "terminal.plain.list",
    params: { scope: INDEPENDENT_SCOPE },
    // Authority observers store a projection accumulator in the ordinary
    // list slot. This one-shot read must not replace it with a wire response.
    cacheKeyIdentity: ["automation-open", attempt?.terminalId ?? null],
    options: { retry: false, staleTime: 0 },
  });
}

/** A host-created terminal must answer for the exact host and id requested. */
function useAutomationPlainTerminalCreate(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
) {
  return useHostMutation<HostRpcRegistry, "terminal.plain.create">({
    client,
    method: "terminal.plain.create",
    mapVariables: (request) => request,
    resolveResponse: (response, request) => {
      if (
        response.terminal.record.hostId !== hostId ||
        response.terminal.record.terminalId !== request.terminalId
      ) {
        throw new Error(
          "The terminal response did not match the requested host and terminal.",
        );
      }
      return Promise.resolve(response);
    },
    options: { mutationKey: terminalMutationKeys.plainCreate(hostId ?? "") },
  });
}

/** Retry keeps the logical id, but starts a new observation boundary and wake. */
function newAutomationTerminalAttempt(
  input: AutomationTerminalInput,
  previous: AutomationTerminalAttempt | null,
  readinessFailed: boolean,
  retried: boolean,
): AutomationTerminalAttempt {
  return {
    userId: signedInUserId(),
    startedAt: Date.now(),
    sandboxId: previous?.sandboxId ?? input.existing?.sandboxId ?? null,
    knownSandbox: input.existing !== null,
    retried,
    terminalId: previous?.terminalId ?? `landing-term-${uuidv4()}`,
    hostId: readinessFailed
      ? null
      : (previous?.hostId ??
        (input.existing?.awake === true ? input.existing.hostId : null)),
  };
}
