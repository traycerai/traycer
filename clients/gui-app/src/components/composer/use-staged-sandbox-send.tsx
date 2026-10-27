import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import type { SandboxVerbGesture } from "@traycer/protocol/host/sandbox-control";
import {
  SandboxSetupLine,
  type SandboxSetupLineFacts,
} from "@/components/composer/sandbox-setup-line";
import { openStagedShapeSheet } from "@/components/composer/use-sandbox-staging";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { useFolderlessTerminalTarget } from "@/components/epic-canvas/sidebar/use-folderless-terminal-target";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import {
  useSandboxRepairGuestConfigurationOnHost,
  useSandboxSettingsOperation,
} from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { v4 as uuidv4 } from "uuid";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useConfigurationProvidersOpener } from "@/hooks/sandboxes/use-open-configuration-providers";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { teamCannotCoverAnHour } from "@/components/hosts/sandbox-create-model";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import {
  priceClause,
  stageBalanceMc,
  stagePrice,
  stageProviderFor,
  stageSmallestShape,
  type StagePrice,
} from "@/lib/sandboxes/sandbox-stage-model";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { sandboxShapeLabel } from "@/lib/sandboxes/sandbox-strings";
import { startSandboxWake } from "@/lib/sandboxes/sandbox-wake";
import {
  rewakeStagedSandbox,
  runStagedSandbox,
  type StagedRunRequest,
  type StagedSandboxRunDeps,
} from "@/lib/sandboxes/staged-sandbox-run";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import {
  handoffOwnerLive,
  holdHandoffOwner,
  readStagedSandbox,
  stagedCreateNeedsFreshKey,
  useStagedSandbox,
  useStagedSandboxStore,
  type HandoffOwnerWatch,
  type StagedSandbox,
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
   * Called first by a terminal's start. `true` when the stage took it (phase
   * 1 started, or is already running): the surface starts nothing. `false`
   * when nothing is staged, or the stage is in its handoff and the surface's
   * own start should run. A terminal agent's Start passes its launch, which
   * the stage keeps for phase 2; a plain terminal passes `null`. A message
   * sent to a stage is handed to its task instead (`handPendingSandboxSend`).
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
  const deps = useStagedSandboxRunDeps();
  return useCallback(
    (surfaceKey, fresh, request) => {
      if (deps === null) return;
      void runStagedSandbox(surfaceKey, fresh, request, deps);
    },
    [deps],
  );
}

/**
 * Wakes a handed-off stage's sandbox that rested while its send waited
 * (`rewakeStagedSandbox`), with this window's account and host directory.
 */
export function useStagedSandboxWaker(): (surfaceKey: string) => void {
  const deps = useStagedSandboxRunDeps();
  return useCallback(
    (surfaceKey) => {
      if (deps === null) return;
      void rewakeStagedSandbox(surfaceKey, deps);
    },
    [deps],
  );
}

function useStagedSandboxRunDeps(): StagedSandboxRunDeps | null {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useMemo(
    () =>
      binding === null
        ? null
        : {
            auth: binding.auth,
            directory: binding.directory,
            queryClient,
            userId,
            readSettings: async (hostId: string) => {
              const requestSettings = async () => {
                const client = resolveNamedHostClient(binding, hostId);
                if (client === null) throw new Error("Host unavailable");
                return client.request("environment.status", {});
              };
              return queryClient
                .fetchQuery(
                  queryOptions({
                    // A staged wake must not join a status read begun before it.
                    queryKey: [
                      ...hostQueryKeys.method<
                        HostRpcRegistry,
                        "environment.status"
                      >(hostId, "environment.status", {}),
                      "sandbox-settings",
                      uuidv4(),
                    ],
                    queryFn: requestSettings,
                    staleTime: 0,
                    gcTime: 0,
                    retry: false,
                  }),
                )
                .catch((error: unknown) =>
                  error instanceof HostRpcError &&
                  error.code === "E_HOST_UNSUPPORTED" &&
                  error.method === "environment.status"
                    ? ("unsupported" as const)
                    : null,
                );
            },
            wake: (hostId: string, gesture: SandboxVerbGesture) =>
              startSandboxWake(queryClient, binding, hostId, gesture).then(
                (outcome) => outcome !== null && outcome.kind === "awake",
              ),
            now: Date.now,
            sleep: (ms: number) =>
              new Promise<void>((resolve) => {
                setTimeout(resolve, ms);
              }),
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
 * A terminal asked for on the landing composer's stage: the panel's `+` and
 * the staged block's `Open terminal instead`. The stage takes it as its first
 * action, and the start page's terminal panel opens it on the sandbox once it
 * is awake (`handOff`); a sandbox that is up already opens it there now. The
 * same credit checks as a send, and no agent sign-in.
 */
export function openLandingStagedTerminal(
  surfaceKey: string,
  runner: StagedSandboxRunner,
): StagedTerminalAsk {
  const ask = startStagedTerminal(surfaceKey, (fresh) =>
    runner(surfaceKey, fresh, {
      fallbackName: stagedSandboxFallbackName(""),
      taskId: null,
      resume: false,
    }),
  );
  if (ask.kind === "awake") {
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(surfaceKey, ask.hostId);
    useLandingPanelStore.getState().requestTerminal(surfaceKey, ask.hostId);
  }
  return ask;
}

/** {@link openLandingStagedTerminal} for the landing composer's staged block. */
export function useOpenLandingStagedTerminal(surfaceKey: string): () => void {
  const runner = useStagedSandboxRunner();
  return useCallback(() => {
    openLandingStagedTerminal(surfaceKey, runner);
  }, [runner, surfaceKey]);
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
  /**
   * Whether this composer holds the draft that sent, whichever owner sent
   * it: the modal's draft is the epic's, shared by its tabs. A landing draft
   * or the picker holds only its own, so a line action there takes over a
   * gone draft's boot without its send.
   */
  readonly claimsSend: boolean;
}): StagedSandboxSend {
  const { surfaceKey, terminal, taskId, ownerId, claimsSend } = input;
  const stage = useStagedSandbox(surfaceKey ?? "");
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
        resume: false,
      });
    },
    [runner, surfaceKey, taskId],
  );
  // A line action on a stage whose sending draft is gone (its modal's tab or
  // its start page closed) is this composer's. The handoff resubmits the send
  // only where this composer holds the draft that sent (`claimsSend`); a
  // stage carrying a terminal ask and no send keeps to the terminal, and one
  // with nothing to resubmit ends on the awake sandbox, the surface pinned.
  const runFromLine = useCallback(
    (fresh: boolean): void => {
      if (surfaceKey === null) return;
      const current = readStagedSandbox(surfaceKey);
      if (current !== null && !handoffOwnerLive(surfaceKey, current.ownerId)) {
        useStagedSandboxStore.getState().report(surfaceKey, {
          ownerId,
          sendTaken: current.sendTaken || (claimsSend && !current.openTerminal),
        });
      }
      run(fresh);
    },
    [claimsSend, ownerId, run, surfaceKey],
  );
  // The draft's resubmit on the ready sandbox, again. A draft that is gone
  // leaves nothing to send but where this composer holds it.
  const onSendAgain = useCallback((): void => {
    if (surfaceKey === null) return;
    const current = readStagedSandbox(surfaceKey);
    if (current === null) return;
    if (handoffOwnerLive(surfaceKey, current.ownerId)) {
      useStagedSandboxStore.getState().report(surfaceKey, { failure: null });
    } else if (claimsSend) {
      useStagedSandboxStore
        .getState()
        .report(surfaceKey, { ownerId, failure: null });
    } else {
      useStagedSandboxStore.getState().clear(surfaceKey);
    }
  }, [claimsSend, ownerId, surfaceKey]);
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

  const facts = useSetupLineFacts(stage);
  const providersOpener = useConfigurationProvidersOpener(
    stage?.target.configuration.kind === "team",
  );

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
          onSendAgain,
          onChangeShape: () => {
            useStagedSandboxStore.getState().cancel(surfaceKey);
            openStagedShapeSheet(surfaceKey);
          },
          onRetryApplying: newHost.onRetryApplying,
          applyingPending: newHost.applyingPending,
          applyingError: newHost.applyingError,
          onStop: () => {
            if (stage.createdSandboxId !== null) verb.mutate("stop");
            useStagedSandboxStore.getState().clear(surfaceKey);
          },
          onOpenTerminal: newHost.onOpenTerminal,
          onOpenProviders: providersOpener(stage.target.configuration),
        }}
      />
    );

  return { intercept, line };
}

/**
 * The facts the setup line reads beyond its stage: the cost line, and for the
 * shape refusal the region, the shape and whether a smaller one is affordable.
 * `null` while there is no stage.
 */
export function useSetupLineFacts(
  stage: StagedSandbox | null,
): SandboxSetupLineFacts | null {
  const user = useAuthUser().data ?? null;
  const catalogue = useSandboxCatalogue(stage !== null).data ?? null;
  const sandboxes = useSandboxList().data?.sandboxes;
  // A resting sandbox of the person's costs what its row says.
  const existingPrice = useMemo<StagePrice | null>(() => {
    if (stage === null || stage.target.kind !== "existing") return null;
    const sandboxId = stage.target.sandboxId;
    const row = sandboxes?.find((candidate) => candidate.id === sandboxId);
    return row === undefined || row.priceMcPerHour === null
      ? null
      : { awakeMcPerHour: row.priceMcPerHour.awakeMc, exact: true };
  }, [sandboxes, stage]);
  return useMemo(() => {
    if (stage === null) return null;
    if (stage.target.kind === "existing" || catalogue === null) {
      return {
        costLine: priceClause({
          configuration: stage.target.configuration,
          price: existingPrice,
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
      // A region the catalogue does not name is left unsaid, never its id.
      regionLabel: region === null ? "" : region.label,
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
  }, [catalogue, existingPrice, stage, user]);
}

/**
 * What a staged resubmit did: `true` its create went out, `false` it was
 * refused because no agent runs on the new host, or, while the send is still
 * being prepared (its images read and inlined), a promise of whether it
 * reached its create.
 */
export type StagedResubmit = boolean | Promise<boolean>;

/**
 * The handoff each surface's resubmit is still being prepared for, so the
 * sending draft's composer mounted again meanwhile (a draft switch and back)
 * waits for it rather than sending it a second time.
 */
const resubmitsInFlight = new Map<string, string>();

function handoffIdentity(stage: StagedSandbox): string {
  return [stage.clientRequestId, stage.createdHostId, stage.ownerId].join(
    "\u0000",
  );
}

/**
 * A prepared resubmit's answer, for the handoff it was made for only: one
 * cleared or replaced meanwhile is not this send's. Sent, the stage ends;
 * stopped short, the line says so and Retry makes it again.
 */
function settleResubmit(
  surfaceKey: string,
  handedOff: string,
  accepted: boolean,
): void {
  if (resubmitsInFlight.get(surfaceKey) === handedOff) {
    resubmitsInFlight.delete(surfaceKey);
  }
  const current = readStagedSandbox(surfaceKey);
  if (
    current === null ||
    current.phase !== "handoff" ||
    handoffIdentity(current) !== handedOff
  ) {
    return;
  }
  if (accepted) {
    useStagedSandboxStore.getState().clear(surfaceKey);
    return;
  }
  useStagedSandboxStore
    .getState()
    .report(surfaceKey, { failure: { kind: "not-sent" } });
}

/**
 * Phase 2 of a staged sandbox: once the surface's placement resolves to the
 * new host, the surface's own `submit` runs again, so the create, the by-hash
 * upload and the backstop run on the new host's client as for any host; the
 * stage clears once that create goes out, and holds the handoff while its
 * images are prepared. `prepareHandoff` runs once before that resubmit (the
 * landing composer resets its workspace to the new host's empty one). A
 * refusal on the line holds the resubmit until its Retry clears it.
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
  readonly submit: () => StagedResubmit;
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
  const handoff =
    stage !== null && stage.phase === "handoff" && stage.ownerId === ownerId
      ? stage
      : null;
  const preparedHostId = handoff?.createdHostId ?? null;
  const handoffHostId =
    handoff !== null && handoff.failure === null ? handoff.createdHostId : null;
  const handoffId = handoff === null ? null : handoffIdentity(handoff);
  useEffect(() => {
    if (surfaceKey === null || preparedHostId === null || handoffId === null) {
      // No handoff now: a later one to the same host runs again.
      preparedRef.current = null;
      handedOffRef.current = null;
      return;
    }
    if (handoffHostId === null) {
      // Refused: Retry clears the refusal and the resubmit runs again.
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
    if (resubmitsInFlight.get(surfaceKey) === handoffId) return;
    handedOffRef.current = key;
    const outcome = submit();
    if (outcome === true) {
      useStagedSandboxStore.getState().clear(surfaceKey);
      return;
    }
    if (outcome === false) {
      // Refused on the new host (no agent it can run): the sandbox stays
      // awake, the draft stays, and the line says why with what to do next.
      useStagedSandboxStore
        .getState()
        .report(surfaceKey, { failure: { kind: "no-provider" } });
      return;
    }
    resubmitsInFlight.set(surfaceKey, handoffId);
    void outcome
      .catch(() => false)
      .then((accepted) => {
        settleResubmit(surfaceKey, handoffId, accepted);
      });
  }, [
    canSubmit,
    handoffHostId,
    handoffId,
    preparedHostId,
    preparations,
    prepareHandoff,
    resolvedHostId,
    submit,
    surfaceKey,
  ]);
}

/** Where the surface opens a terminal on the new host, in its epic. */
export interface StagedSandboxTerminal {
  readonly epicId: string;
  readonly open: (target: TerminalLaunchTarget) => void;
}

/**
 * The line's actions on the created host: `Retry applying` repairs the
 * settings there, then the wait resumes on the new verdict; `Open terminal`
 * opens a folderless one there once the host can.
 */
export function useNewHostActions(
  surfaceKey: string | null,
  createdHostId: string | null,
  terminal: StagedSandboxTerminal | null,
  run: (fresh: boolean) => void,
): {
  readonly onRetryApplying: () => void;
  readonly applyingPending: boolean;
  readonly applyingError: boolean;
  readonly onOpenTerminal: (() => void) | null;
} {
  const repair = useSandboxRepairGuestConfigurationOnHost(createdHostId ?? "");
  const operation = useSandboxSettingsOperation(createdHostId ?? "");
  const terminalTarget = useFolderlessTerminalTarget(
    terminal === null ? "" : terminal.epicId,
    terminal === null ? null : createdHostId,
  );
  return {
    applyingPending: operation === "pending",
    applyingError: operation === "failed",
    onRetryApplying: () => {
      if (
        surfaceKey === null ||
        createdHostId === null ||
        operation === "pending"
      )
        return;
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
