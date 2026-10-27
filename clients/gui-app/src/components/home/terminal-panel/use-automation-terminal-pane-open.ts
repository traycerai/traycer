import { useEffect, useRef, useState } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  SandboxAutomationOpenTarget,
  SandboxAutomationResponse,
} from "@traycer/protocol/host/sandbox-control";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useAutomationTerminalReadinessFailed,
  type AutomationTerminalAttempt,
} from "./use-automation-terminal-readiness";
import { useFolderlessTerminalLaunch } from "@/components/epic-canvas/sidebar/use-folderless-terminal-target";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
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

import { automationTerminalTarget } from "@/lib/sandboxes/automation-terminal-target";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useSandboxAutomationOpen } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import { useSandboxAutomation } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { settledForStartingAccount } from "@/lib/sandboxes/sandbox-account-fence";
import {
  useLandingPanelStore,
  type AutomationTerminalRequest,
} from "@/stores/home/landing-panel-store";

const INDEPENDENT_SCOPE: PlainTerminalScope = { kind: "independent" };

/** The pane owns the operation, so leaving Settings cannot cancel it. */
export function useAutomationTerminalPaneOpen(
  request: AutomationTerminalRequest,
  instanceId: string,
) {
  const { teamEnvironmentId } = request;
  const open = useSandboxAutomationOpen("inline");
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<AutomationTerminalAttempt>(() =>
    newAutomationTerminalAttempt(request, null, false),
  );
  const currentAttempt = useRef<AutomationTerminalAttempt | null>(attempt);
  const dispatched = useRef(false);
  const wakeDispatched = useRef<AutomationTerminalAttempt | null>(null);
  const [retryCode, setRetryCode] = useState<string | null>(null);
  useEffect(() => {
    currentAttempt.current = attempt;
    return () => {
      currentAttempt.current = null;
    };
  }, [attempt]);
  const automation = useSandboxAutomation(teamEnvironmentId);
  const { target: openTarget, failureCode: podFailureCode } =
    automationTerminalWakeTarget(attempt, teamEnvironmentId, automation);
  const activeAttempt = settledForStartingAccount(attempt) ? attempt : null;
  const hostId = activeAttempt === null ? null : activeAttempt.hostId;
  const client = useHostClientForHostId(hostId);
  // The directory/list reads negotiate this host's manifest. Unknown support
  // waits for that answer; a known absence is a retryable opening failure.
  const createSupport = useHostMethodSupport(hostId, "terminal.plain.create");
  const readinessFailed = useAutomationTerminalReadinessFailed(activeAttempt);
  // As in the new-terminal picker, an independent launch has no epic. The
  // directory query waits for the named host's endpoint and keeps its errors.
  const launch = useFolderlessTerminalLaunch("", hostId);
  const list = useAutomationTerminalList(client, activeAttempt);
  const create = useAutomationPlainTerminalCreate(
    client,
    hostId,
    createSupport,
  );
  const failureCode =
    podFailureCode ??
    automationTerminalFailureCode({
      wakeError: open.error,
      readinessFailed,
      directoryFailed: launch.failed,
      directoryError: launch.bindings.error,
      listError: list.error,
      createError: create.error,
      unsupported: createSupport === false,
    });
  const failed = failureCode !== null;
  const starting =
    open.isPending ||
    !failed ||
    launch.bindings.isFetching ||
    list.isFetching ||
    create.isPending;
  const { mutateAsync: createTerminal } = create;
  useEffect(() => {
    if (
      attempt.hostId === null ||
      currentAttempt.current !== attempt ||
      !settledForStartingAccount(attempt) ||
      failed ||
      createSupport !== true ||
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
        panel.fulfillPlaceholder(
          {
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
          },
          instanceId,
        );
        focusTerminalInstance(instanceId);
        currentAttempt.current = null;
      },
      () => undefined,
    );
  }, [
    attempt,
    client,
    createTerminal,
    createSupport,
    failed,
    launch.bindings.isFetching,
    launch.target,
    list.isFetching,
    list.isSuccess,
    queryClient,
    instanceId,
  ]);
  const { mutateAsync: wake } = open;
  // Wake exactly once per observation attempt, including after a failed wake.
  useEffect(() => {
    if (
      attempt.hostId !== null ||
      openTarget === undefined ||
      currentAttempt.current !== attempt ||
      wakeDispatched.current === attempt ||
      !settledForStartingAccount(attempt)
    )
      return;
    // Let the pane's observers attach before dispatch. React's mount replay
    // may dispose this effect once; that discarded mount must start nothing.
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || wakeDispatched.current === attempt) return;
      wakeDispatched.current = attempt;
      void wake(openTarget).then(
        (opened) => {
          if (
            currentAttempt.current !== attempt ||
            !settledForStartingAccount(attempt)
          )
            return;
          const ready = {
            ...attempt,
            startedAt: Date.now(),
            hostId: opened.sandbox.hostId,
            sandboxId: opened.sandbox.id,
          };
          currentAttempt.current = ready;
          setAttempt(ready);
        },
        () => undefined,
      );
    });
    return () => {
      disposed = true;
    };
  }, [attempt, openTarget, wake]);
  const run = (): void => {
    if (starting || currentAttempt.current !== attempt) return;
    setRetryCode(failureCode);
    open.reset();
    create.reset();
    if (podFailureCode !== null) void automation.refetch();
    dispatched.current = false;
    const next = newAutomationTerminalAttempt(
      request,
      attempt,
      readinessFailed,
    );
    currentAttempt.current = next;
    setAttempt(next);
    if (next.hostId !== null && attempt.hostId === next.hostId) {
      void launch.bindings.refetch();
      void list.refetch();
    }
  };
  return {
    run,
    starting,
    failureCode: failureCode ?? retryCode,
    hostId: activeAttempt?.hostId ?? request.existing?.hostId ?? null,
  };
}

/** Only a successful pod lookup can authorize waking a specifically named pod. */
function automationTerminalWakeTarget(
  attempt: AutomationTerminalAttempt,
  teamEnvironmentId: string | null,
  automation: UseQueryResult<SandboxAutomationResponse | null>,
): {
  readonly target: SandboxAutomationOpenTarget | null | undefined;
  readonly failureCode: string | null;
} {
  const target = automationTerminalTarget(
    attempt.sandboxId,
    teamEnvironmentId,
    automation.data?.pods ?? [],
  );
  if (
    teamEnvironmentId === null ||
    attempt.sandboxId === null ||
    attempt.hostId !== null
  )
    return { target, failureCode: null };
  if (automation.isPending || automation.isFetching)
    return { target: undefined, failureCode: null };
  if (automation.isError)
    return { target: undefined, failureCode: "automation-pod-query-failed" };
  return {
    target,
    failureCode: target === undefined ? "automation-pod-missing" : null,
  };
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
  support: boolean | null,
) {
  return useHostMutation<HostRpcRegistry, "terminal.plain.create">({
    client,
    method: "terminal.plain.create",
    mapVariables: (request) => {
      if (support !== true) {
        throw new Error("The host does not support terminal creation.");
      }
      return request;
    },
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
  input: AutomationTerminalRequest,
  previous: AutomationTerminalAttempt | null,
  readinessFailed: boolean,
): AutomationTerminalAttempt {
  return {
    userId: input.userId,
    startedAt: previous === null ? input.startedAt : Date.now(),
    sandboxId: previous?.sandboxId ?? input.existing?.sandboxId ?? null,
    knownSandbox: input.existing !== null,
    terminalId: input.terminalId,
    hostId: readinessFailed
      ? null
      : (previous?.hostId ??
        (input.existing?.awake === true ? input.existing.hostId : null)),
  };
}

/** Only typed diagnostics are exposed; guest and transport messages stay private. */
function automationTerminalFailureCode(failure: {
  readonly wakeError: Error | null;
  readonly readinessFailed: boolean;
  readonly directoryFailed: boolean;
  readonly directoryError: Error | null;
  readonly listError: Error | null;
  readonly createError: Error | null;
  readonly unsupported: boolean;
}): string | null {
  if (failure.wakeError instanceof SandboxOperationError) {
    return failure.wakeError.failure.kind === "refused"
      ? failure.wakeError.failure.code
      : failure.wakeError.failure.kind;
  }
  if (failure.wakeError !== null) return "automation-start-failed";
  if (failure.readinessFailed) return "automation-not-awake";
  if (failure.unsupported) return "E_HOST_UNSUPPORTED";
  if (failure.directoryFailed)
    return failure.directoryError instanceof HostRpcError
      ? failure.directoryError.code
      : "folderless-directory-unavailable";
  if (failure.listError !== null)
    return failure.listError instanceof HostRpcError
      ? failure.listError.code
      : "terminal-list-failed";
  if (failure.createError !== null)
    return failure.createError instanceof HostRpcError
      ? failure.createError.code
      : "terminal-create-failed";
  return null;
}
