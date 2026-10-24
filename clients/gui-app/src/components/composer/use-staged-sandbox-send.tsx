import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SandboxSetupLine } from "@/components/composer/sandbox-setup-line";
import { openStagedShapeSheet } from "@/components/composer/use-sandbox-staging";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { useFolderlessTerminalTarget } from "@/components/epic-canvas/sidebar/use-folderless-terminal-target";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useSandboxRepairGuestConfigurationOnHost } from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { teamCannotCoverAnHour } from "@/components/hosts/sandbox-create-model";
import { useHostBinding } from "@/lib/host";
import {
  priceClause,
  stageBalanceMc,
  stagePrice,
  stageProviderFor,
  stageSmallestShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import { sandboxShapeLabel } from "@/lib/sandboxes/sandbox-strings";
import { startSandboxWake } from "@/lib/sandboxes/sandbox-wake";
import {
  runStagedSandbox,
  type StagedRunRequest,
} from "@/lib/sandboxes/staged-sandbox-run";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  handoffOwnerLive,
  holdHandoffOwner,
  readStagedSandbox,
  stagedCreateNeedsFreshKey,
  useStagedSandbox,
  useStagedSandboxStore,
  type HandoffOwnerWatch,
} from "@/stores/composer/staged-sandbox-store";

/** A sandbox's name when the shape sheet set none: the message's first words. */
const FALLBACK_NAME_WORDS = 4;
const FALLBACK_NAME = "sandbox";
/** The create's longest `displayName`. */
const FALLBACK_NAME_MAX_LENGTH = 191;

export function stagedSandboxFallbackName(text: string): string {
  const slug = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, FALLBACK_NAME_WORDS)
    .join("-")
    .slice(0, FALLBACK_NAME_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug.length === 0 ? FALLBACK_NAME : slug;
}

export interface StagedSandboxSend {
  /**
   * Called first by the surface's submit. `true` when the stage took the
   * send (phase 1 started, or is already running): the surface submits
   * nothing and keeps the draft. `false` when nothing is staged, or the stage
   * is in its handoff and the surface's own submit should run. A taken
   * terminal agent's Start passes its launch, which the stage keeps for
   * phase 2; a send passes `null`.
   */
  readonly intercept: (
    messageText: string,
    terminalLaunch: TerminalAgentLaunch | null,
  ) => boolean;
  /** The setup line, above the draft. */
  readonly line: ReactNode;
}

/** Starts phase 1 of a surface's stage: its create or wake, then the wait. */
export type StagedSandboxRunner = (
  surfaceKey: string,
  fresh: boolean,
  request: StagedRunRequest,
) => void;

/**
 * Runs `runStagedSandbox` with this window's account and host directory. The
 * run is owned by the store, so the caller may unmount while it goes on.
 */
export function useStagedSandboxRunner(): StagedSandboxRunner {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useCallback(
    (surfaceKey, fresh, request) => {
      if (binding === null) return;
      void runStagedSandbox(surfaceKey, fresh, request, {
        auth: binding.auth,
        directory: binding.directory,
        queryClient,
        userId,
        wake: (hostId) =>
          startSandboxWake(queryClient, binding, hostId).then(
            (outcome) => outcome !== null && outcome.kind === "awake",
          ),
        now: Date.now,
        sleep: (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          }),
      });
    },
    [binding, queryClient, userId],
  );
}

/** What became of an explicit terminal ask on a surface's stage. */
export type StagedTerminalAsk =
  /** The stage took it: the terminal opens on the handoff. */
  | { readonly kind: "taken" }
  /** The stage's sandbox is awake already: open the terminal there now. */
  | { readonly kind: "awake"; readonly hostId: string }
  /** The stage cannot take it: the caller opens its terminal as it would. */
  | { readonly kind: "not-taken" };

/**
 * An explicit terminal ask on a surface's stage (a Settings row's Open
 * terminal, the landing panel's `+`) is a first action, as a send is: the
 * stage is marked to open a folderless terminal on its sandbox once it is
 * awake, and its create or wake starts when none is running. A run that
 * stopped short starts again as the line's Retry or Keep waiting would, under
 * the key the stage's rule names. A sandbox that is up with settings that did
 * not apply is awake: its terminal opens there now. While a stage holds the
 * surface the ask never falls through to the host the surface falls back to;
 * only a stage in its handoff (the surface is already on the sandbox) leaves
 * it to the caller.
 */
export function startStagedTerminal(
  surfaceKey: string,
  start: (fresh: boolean) => void,
): StagedTerminalAsk {
  const current = readStagedSandbox(surfaceKey);
  if (current === null || current.phase === "handoff") {
    return { kind: "not-taken" };
  }
  if (current.failure?.kind === "settings" && current.createdHostId !== null) {
    return { kind: "awake", hostId: current.createdHostId };
  }
  useStagedSandboxStore.getState().report(surfaceKey, { openTerminal: true });
  if (current.phase === "staged" || current.failure !== null) {
    start(stagedCreateNeedsFreshKey(current));
  }
  return { kind: "taken" };
}

/**
 * The send side of a staged sandbox (sandboxes plan D1, the critique's
 * two-phase handoff). Phase 1 creates or wakes the staged sandbox and waits
 * until it is ready, then pins the surface to it (`runStagedSandbox`); phase
 * 2 is {@link useStagedSandboxHandoff}'s.
 *
 * `surfaceKey` `null` stages nothing (a request that named its host).
 *
 * `terminal` opens a folderless terminal on the new host from the line, in
 * the surface's epic; `null` where the surface has no epic to open it in.
 */
export function useStagedSandboxSend(input: {
  readonly surfaceKey: string | null;
  readonly terminal: StagedSandboxTerminal | null;
  /** The task the surface is in, which the create names; `null` on landing. */
  readonly taskId: string | null;
  /**
   * The draft this composer holds, where the surface's stage is shared by
   * several (landing): the handoff resubmits only the one that sent.
   */
  readonly ownerId: string | null;
}): StagedSandboxSend {
  const { surfaceKey, terminal, taskId, ownerId } = input;
  const stage = useStagedSandbox(surfaceKey ?? "");
  const user = useAuthUser().data ?? null;
  const catalogue = useSandboxCatalogue(stage !== null).data ?? null;
  const verb = useSandboxVerb(stage?.createdSandboxId ?? "");
  const messageTextRef = useRef("");
  // The name the create falls back to, for the line to show meanwhile.
  const [fallbackName, setFallbackName] = useState(FALLBACK_NAME);
  const runner = useStagedSandboxRunner();

  const run = useCallback(
    (fresh: boolean): void => {
      if (surfaceKey === null) return;
      runner(surfaceKey, fresh, {
        fallbackName: stagedSandboxFallbackName(messageTextRef.current),
        taskId,
      });
    },
    [runner, surfaceKey, taskId],
  );
  // A line action on a stage whose sending draft is gone (its modal's tab or
  // its start page closed) is this draft's: the handoff resubmits it. A stage
  // carrying a terminal ask and no send keeps to the terminal.
  const runFromLine = useCallback(
    (fresh: boolean): void => {
      if (surfaceKey === null) return;
      const current = readStagedSandbox(surfaceKey);
      if (current !== null && !handoffOwnerLive(surfaceKey, current.ownerId)) {
        useStagedSandboxStore.getState().report(surfaceKey, {
          ownerId,
          sendTaken: current.sendTaken || !current.openTerminal,
        });
      }
      run(fresh);
    },
    [ownerId, run, surfaceKey],
  );
  const newHost = useNewHostActions(
    surfaceKey,
    stage?.createdHostId ?? null,
    terminal,
    runFromLine,
  );

  const intercept = useCallback(
    (
      messageText: string,
      terminalLaunch: TerminalAgentLaunch | null,
    ): boolean => {
      if (surfaceKey === null) return false;
      const current = readStagedSandbox(surfaceKey);
      if (current === null) return false;
      if (current.phase === "handoff") {
        // The resubmit on the new host was refused: this send is the
        // person's own, on the host the surface is already pinned to.
        if (current.failure !== null) {
          useStagedSandboxStore.getState().clear(surfaceKey);
        }
        return false;
      }
      // A first action that stopped short leaves a stage like any other: the
      // send runs it again. The action it hands off is the owner's alone; one
      // in flight takes any other send and records nothing, and the chip says
      // it is busy. A boot with no send (a terminal ask started it, or the
      // draft that sent is gone) is handed off with this one.
      if (current.phase === "staged" || current.failure !== null) {
        messageTextRef.current = messageText;
        setFallbackName(stagedSandboxFallbackName(messageText));
        useStagedSandboxStore
          .getState()
          .report(surfaceKey, { ownerId, terminalLaunch, sendTaken: true });
        run(stagedCreateNeedsFreshKey(current));
      } else if (!current.sendTaken) {
        useStagedSandboxStore
          .getState()
          .report(surfaceKey, { ownerId, terminalLaunch, sendTaken: true });
      }
      return true;
    },
    [ownerId, run, surfaceKey],
  );

  const facts = useMemo(() => {
    if (stage === null) return null;
    if (stage.target.kind === "existing" || catalogue === null) {
      return {
        costLine: priceClause({
          configuration: stage.target.configuration,
          price: null,
          needsCredits: false,
          audience: "private",
          reachHost: null,
          unmovedComputer: null,
        }).text,
        regionLabel: "",
        shapeLabel: "",
        smallerShapeAffordable: false,
      };
    }
    const { shape, configuration } = stage.target;
    const price = stagePrice(catalogue, shape);
    const smallest = stageSmallestShape(catalogue, shape);
    const region =
      stageProviderFor(catalogue, shape.os)?.regions.find(
        (candidate) => candidate.id === shape.region,
      ) ?? null;
    return {
      costLine: priceClause({
        configuration,
        price,
        needsCredits: false,
        audience: "private",
        reachHost: null,
        unmovedComputer: null,
      }).text,
      regionLabel: region === null ? shape.region : region.label,
      shapeLabel: sandboxShapeLabel(shape.cpus, shape.memoryMb),
      // A larger staged shape has a smaller one the balance covers when it
      // covers the smallest's hour.
      smallerShapeAffordable:
        smallest !== null &&
        !smallest.isStaged &&
        !teamCannotCoverAnHour(
          stageBalanceMc(user, configuration),
          smallest.awakeMcPerHour,
        ),
    };
  }, [catalogue, stage, user]);

  const line =
    surfaceKey === null || stage === null || facts === null ? null : (
      <SandboxSetupLine
        stage={stage}
        name={stage.target.name.length > 0 ? stage.target.name : fallbackName}
        facts={facts}
        actions={{
          onKeepWaiting: () => runFromLine(false),
          onCancel: () => useStagedSandboxStore.getState().cancel(surfaceKey),
          onChooseAnotherHost: () =>
            useStagedSandboxStore.getState().clear(surfaceKey),
          onRetryCreation: () => runFromLine(true),
          onRetry: () => runFromLine(stagedCreateNeedsFreshKey(stage)),
          onChangeShape: () => {
            useStagedSandboxStore.getState().cancel(surfaceKey);
            openStagedShapeSheet(surfaceKey);
          },
          onRetryApplying: newHost.onRetryApplying,
          onStop: () => {
            if (stage.createdSandboxId !== null) verb.mutate("stop");
            useStagedSandboxStore.getState().clear(surfaceKey);
          },
          onOpenTerminal: newHost.onOpenTerminal,
          onOpenProviders: null,
        }}
      />
    );

  return { intercept, line };
}

/**
 * Phase 2 of a staged sandbox: once the surface's placement resolves to the
 * new host, the surface's own `submit` runs again, so the create, the by-hash
 * upload and the backstop run on the new host's client as for any host; then
 * the stage clears. `prepareHandoff` runs once before that resubmit (the
 * landing composer resets its workspace to the new host's empty one).
 *
 * Mounted by whatever outlives the sending surface: the composer itself, or
 * a tab-level owner where the surface is a popover. A handoff whose sending
 * draft is gone before it resubmits is dropped (`holdHandoffOwner`), as
 * `watchOwner` says.
 */
export function useStagedSandboxHandoff(input: {
  readonly surfaceKey: string | null;
  readonly resolvedHostId: string | null;
  readonly canSubmit: boolean;
  readonly submit: () => boolean;
  readonly prepareHandoff: (hostId: string) => void;
  readonly ownerId: string | null;
  /** When the draft is gone once this unmounts; stable across renders. */
  readonly watchOwner: HandoffOwnerWatch;
}): void {
  const {
    surfaceKey,
    resolvedHostId,
    canSubmit,
    submit,
    prepareHandoff,
    ownerId,
    watchOwner,
  } = input;
  const stage = useStagedSandbox(surfaceKey ?? "");
  useEffect(() => {
    if (surfaceKey === null) return;
    return holdHandoffOwner(surfaceKey, ownerId, watchOwner);
  }, [ownerId, surfaceKey, watchOwner]);
  // Once per handoff.
  const handedOffRef = useRef<string | null>(null);
  const preparedRef = useRef<string | null>(null);
  // Counts preparations, so the effect runs again on the render that holds
  // the prepared draft (a timestamp can repeat within a millisecond).
  const [preparations, markPrepared] = useReducer(
    (count: number) => count + 1,
    0,
  );
  const handoffHostId =
    stage !== null && stage.phase === "handoff" && stage.ownerId === ownerId
      ? stage.createdHostId
      : null;
  useEffect(() => {
    if (surfaceKey === null || handoffHostId === null) {
      // No handoff now: a later one to the same host runs again.
      preparedRef.current = null;
      handedOffRef.current = null;
      return;
    }
    if (resolvedHostId !== handoffHostId) return;
    const key = `${surfaceKey}\u0000${handoffHostId}`;
    if (preparedRef.current !== key) {
      preparedRef.current = key;
      prepareHandoff(handoffHostId);
      // A render with the prepared draft, whatever `prepareHandoff` changed,
      // so the resubmit below reads it.
      markPrepared();
      return;
    }
    if (handedOffRef.current === key || !canSubmit) return;
    handedOffRef.current = key;
    if (submit()) {
      useStagedSandboxStore.getState().clear(surfaceKey);
      return;
    }
    // Refused on the new host (no agent it can run): the sandbox stays
    // awake, the draft stays, and the line says why with what to do next.
    useStagedSandboxStore
      .getState()
      .report(surfaceKey, { failure: { kind: "no-provider" } });
  }, [
    canSubmit,
    handoffHostId,
    preparations,
    prepareHandoff,
    resolvedHostId,
    submit,
    surfaceKey,
  ]);
}

/** Where the surface opens a terminal on the new host, in its epic. */
interface StagedSandboxTerminal {
  readonly epicId: string;
  readonly open: (target: TerminalLaunchTarget) => void;
}

/**
 * The line's actions on the created host: `Retry applying` repairs the
 * settings there, then the wait resumes on the new verdict; `Open terminal`
 * opens a folderless one there once the host can.
 */
function useNewHostActions(
  surfaceKey: string | null,
  createdHostId: string | null,
  terminal: StagedSandboxTerminal | null,
  run: (fresh: boolean) => void,
): {
  readonly onRetryApplying: () => void;
  readonly onOpenTerminal: (() => void) | null;
} {
  const repair = useSandboxRepairGuestConfigurationOnHost(createdHostId ?? "");
  const terminalTarget = useFolderlessTerminalTarget(
    terminal === null ? "" : terminal.epicId,
    terminal === null ? null : createdHostId,
  );
  return {
    onRetryApplying: () => {
      if (surfaceKey === null || createdHostId === null) return;
      const origin = readStagedSandbox(surfaceKey);
      if (origin === null) return;
      repair.mutate(
        {},
        {
          // The wait resumes only for the stage the repair was for: another
          // pick made meanwhile is created by its own send, never by this.
          onSuccess: () => {
            const current = readStagedSandbox(surfaceKey);
            if (
              current === null ||
              current.clientRequestId !== origin.clientRequestId ||
              current.createdHostId !== createdHostId
            ) {
              return;
            }
            run(false);
          },
        },
      );
    },
    onOpenTerminal:
      terminal === null || terminalTarget === null
        ? null
        : () => terminal.open(terminalTarget),
  };
}
