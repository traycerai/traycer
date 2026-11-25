import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { v5 as uuidv5 } from "uuid";
import type { PlainTerminalScope } from "@traycer/protocol/host/terminal/plain-schemas";
import type { NestedFocusProvenance } from "@/lib/epic-nested-focus-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  claimDraftAuthorityEffect,
  claimDraftAuthorityRestoredTerminal,
  readDraftAuthorityRestoredIssue,
} from "@/lib/drafts/draft-authority-pending";
import { draftAuthorityActorIsCurrent } from "@/lib/drafts/draft-authority-session";
import { draftStorageRefusalPresentation } from "@/lib/drafts/draft-storage-refusal";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { sandboxListReadSentAt, useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useHostPlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { captureRestoredDraftAction } from "@/lib/sandboxes/restored-draft-action";
import {
  createProtectedEpicTerminal,
  protectedEpicTerminalCanAttestLegacy,
} from "@/lib/terminals/epic-terminal-protected-create";
import {
  EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_COLS,
  EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_ROWS,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { makeListedEpicTerminalRef } from "@/lib/terminals/listed-epic-terminal-ref";
import {
  adoptPlainTerminalUnary,
  capturePlainTerminalProjectionBarrier,
  getPlainTerminal,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { upsertCreatedSessionIntoExactTerminalList } from "@/lib/terminals/refresh-host-terminal-list";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import { hostQueryKeys } from "@/lib/query-keys";
import { readStagedSandbox, useStagedSandbox, type StagedSandbox } from "@/stores/composer/staged-sandbox-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  captureCanonicalTaskDraft,
  flushCanonicalTaskDraft,
} from "@/stores/epics/new-conversation-modal-store";
import type { TerminalLaunchTarget } from "./new-terminal-tile-ref";
import { useFolderlessTerminalTarget } from "./use-folderless-terminal-target";

function showRestoredOpenRefusal(): void {
  const presentation = draftStorageRefusalPresentation("restored-open");
  if (presentation.kind === "composer-failure")
    toast.error(presentation.title, { description: presentation.description });
}

/** Issues setup-line Open for the captured returned Task while its sandbox stays awake. */
export function useRestoredTaskTerminal(input: {
  readonly epicId: string;
  readonly tabId: string;
  readonly surfaceKey: string | null;
}) {
  const { epicId, tabId, surfaceKey } = input;
  const stage = useStagedSandbox(surfaceKey ?? "");
  const hostId = stage?.returnedDraft?.kind === "task" ? stage.createdHostId : null;
  const client = useHostClientForHostId(hostId);
  const scope = useMemo<PlainTerminalScope>(() => ({ kind: "epic", epicId }), [epicId]);
  const terminalAuthority = useHostPlainTerminalAuthority({ hostId: hostId ?? "", scope });
  const signedList = useSandboxList();
  const target = useFolderlessTerminalTarget(epicId, hostId);
  const queryClient = useQueryClient();
  const { openTile } = useEpicTileNavigation();
  const live = useRef<{
    readonly target: TerminalLaunchTarget | null;
    readonly list: typeof signedList.data;
    readonly listError: boolean;
    readonly capability: "capable" | "legacy" | null;
    readonly client: typeof client;
  } | null>(null);
  const capability = terminalAuthority.capability.status === "legacy"
    ? "legacy"
    : terminalAuthority.capability.status === "capable" && terminalAuthority.canMutate
      ? "capable"
      : null;
  useLayoutEffect(() => {
    live.current = { target, list: signedList.data, listError: signedList.isError, capability, client };
    return () => { live.current = null; };
  }, [capability, client, signedList.data, signedList.isError, target]);
  const inFlight = useRef<StagedSandbox | null>(null);

  return useCallback((
    boundTarget: TerminalLaunchTarget,
    pressedStage: StagedSandbox,
    provenance: NestedFocusProvenance,
  ): void => {
    const current = live.current;
    const restoration = captureRestoredDraftAction(pressedStage);
    if (
      current === null || current.capability === null || current.client === null ||
      surfaceKey === null || inFlight.current !== null || restoration === null ||
      restoration.source.draft.slot.kind !== "task" ||
      restoration.source.draft.slot.id !== epicId ||
      pressedStage.createdHostId !== boundTarget.hostId ||
      pressedStage.createdSandboxId === null || pressedStage.attemptId === undefined
    ) return;
    const { actor, source } = restoration;
    const { draft } = source;
    const { hostId, cwd } = boundTarget;
    const sandboxId = pressedStage.createdSandboxId;
    const attemptId = pressedStage.attemptId;
    const { capability, client } = current;
    if (capability === "legacy" && !protectedEpicTerminalCanAttestLegacy(hostId)) return;

    const signedAwake = (): boolean => {
      const now = live.current;
      const sentAt = sandboxListReadSentAt(now?.list);
      return now !== null && !now.listError && sentAt !== null &&
        sentAt >= (pressedStage.startedAt ?? 0) &&
        now.list?.sandboxes.some((row) =>
          row.id === sandboxId && row.hostId === hostId &&
          row.state === "awake" && !row.frozen,
        ) === true;
    };
    const isCurrent = (): boolean => {
      const now = live.current;
      const exact = captureCanonicalTaskDraft(epicId);
      return (
        draftAuthorityActorIsCurrent(actor) &&
        readStagedSandbox(surfaceKey) === pressedStage &&
        useEpicCanvasStore.getState().tabsById[tabId]?.epicId === epicId &&
        exact?.occurrence === draft.occurrence && exact.version === draft.version &&
        now?.capability === capability && now.client === client &&
        now.target?.hostId === hostId && now.target.cwd === cwd &&
        client.getActiveHostId() === hostId &&
        signedAwake()
      );
    };
    if (!isCurrent()) return;

    inFlight.current = pressedStage;
    void (async () => {
      const flushed = await flushCanonicalTaskDraft(epicId);
      if (!isCurrent()) return;
      if (flushed.kind === "unavailable") {
        showRestoredOpenRefusal();
        return;
      }
      if (flushed.kind !== "committed" || flushed.draft.occurrence !== draft.occurrence ||
          flushed.draft.version !== draft.version) return;

      const prior = await readDraftAuthorityRestoredIssue({ actor, draft });
      if (!isCurrent()) return;
      if (prior.kind === "unavailable") {
        showRestoredOpenRefusal();
        return;
      }
      if (prior.kind === "denied") return;
      const linked = prior.kind === "current" &&
        (prior.issue.receipt.effect.kind === "create" || prior.issue.receipt.effect.kind === "wake")
        ? prior.issue
        : null;
      const operationId = linked === null
        ? JSON.stringify(["restored-task-open", draft.occurrence, draft.version, attemptId])
        : `${linked.receipt.operationId}:task-open`;
      const terminalId = `term-${uuidv5(operationId, uuidv5.URL)}`;
      const instanceId = uuidv5(`${operationId}:tile`, uuidv5.URL);
      const exactTarget = { epicId, sandboxId, surfaceKey, hostId, terminalId, cwd };
      const storedAttempt = prior.kind === "current" ? prior.issue.receipt.setupAttempt : undefined;
      const observationGeneration = sandboxListReadSentAt(live.current?.list);
      if (observationGeneration === null || (storedAttempt !== undefined &&
          (storedAttempt.attemptId !== attemptId || observationGeneration < storedAttempt.observationGeneration)))
        return;

      const claim = linked !== null
        ? (linked.state === "accepted" && storedAttempt !== undefined &&
            linked.acceptance?.sandboxId === sandboxId && linked.acceptance.hostId === hostId
          ? await claimDraftAuthorityRestoredTerminal({
              handoff: { actor, draft, primary: linked.receipt, operationId, sandboxId, hostId, surfaceKey },
              target: { epicId, terminalId, cwd },
              setupAttempt: storedAttempt,
              isCurrent,
            })
          : null)
        : (pressedStage.target.kind === "existing" &&
            pressedStage.target.sandboxId === sandboxId && pressedStage.target.hostId === hostId &&
            (prior.kind === "missing" || (prior.kind === "current" &&
              prior.issue.receipt.operationId === operationId && storedAttempt !== undefined))
          ? await claimDraftAuthorityEffect({
              actor,
              operationId,
              source,
              effect: { kind: "terminal", phase: "setup", identity: terminalId, payload: exactTarget },
              setupAttempt: storedAttempt ?? { attemptId, observationGeneration },
              expectedIssueGeneration: null,
              recovery: "initial",
            })
          : null);
      if (claim === null || !isCurrent()) return;
      if (claim.kind === "unavailable") {
        showRestoredOpenRefusal();
        return;
      }
      if (claim.kind !== "committed" && claim.kind !== "replayed") return;

      const queryKey = hostQueryKeys.plainTerminals(hostId, scope);
      const before = queryClient.getQueryData<PlainTerminalCollection>(queryKey);
      const barrier = capturePlainTerminalProjectionBarrier(before);
      const result = await createProtectedEpicTerminal({
        actor, draft, claim, target: exactTarget, client, capability, isCurrent,
        grid: {
          cols: EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_COLS,
          rows: EPIC_TERMINAL_DURABLE_CREATE_DEFAULT_ROWS,
        },
      });
      if (result.kind === "held" || !isCurrent()) return;

      if (result.kind === "legacy") {
        const ref = makeListedEpicTerminalRef({
          session: result.session, hostId, instanceId, durable: false, taskHome: null,
        });
        openTile(tileIntent(ref, { tabId }, "explicit", "direct_ui"), provenance);
        upsertCreatedSessionIntoExactTerminalList(queryClient, hostId, scope, result.session);
        return;
      }

      const { terminal } = result;
      const adopted = queryClient.setQueryData<PlainTerminalCollection>(
        queryKey, (collection) => adoptPlainTerminalUnary(collection, terminal, barrier),
      );
      const exact = getPlainTerminal(adopted, hostId, terminalId);
      if (exact === undefined || exact.record.launch.cwd !== cwd) return;
      const name = exact.record.manualTitle ?? DEFAULT_TERMINAL_TITLE;
      openTile(tileIntent({
        type: "terminal", id: terminalId, instanceId, hostId, name, authority: "host",
        legacyFallback: {
          name,
          titleSource: exact.record.manualTitle === null ? "default" : "manual",
          cwd,
          shellCommand: exact.record.launch.shellCommand,
          shellArgs: exact.record.launch.shellArgs,
        },
      }, { tabId }, "explicit", "direct_ui"), provenance);
      useEpicCanvasStore.getState().adoptHostTerminalProjection(hostId, exact);
    })().catch(() => undefined).finally(() => {
      if (inFlight.current === pressedStage) inFlight.current = null;
    });
  }, [epicId, openTile, queryClient, scope, surfaceKey, tabId]);
}
