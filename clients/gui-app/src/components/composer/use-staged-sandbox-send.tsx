import {
  useCallback,
  useEffect,
  useMemo,
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
import { runStagedSandbox } from "@/lib/sandboxes/staged-sandbox-run";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  readStagedSandbox,
  useStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxFailure,
} from "@/stores/composer/staged-sandbox-store";

/**
 * A refusal the server answered before anything was created. Any other
 * failure may follow an accepted, billed create (an answer that never came,
 * a sandbox that failed on its way up), so a send repeats that create; so
 * does any failure once a sandbox was accepted, such as one frozen for
 * credits while it settles.
 */
function refusedBeforeCreate(
  failure: StagedSandboxFailure,
  createdSandboxId: string | null,
): boolean {
  if (createdSandboxId !== null) return false;
  switch (failure.kind) {
    case "credits":
    case "shape":
    case "unavailable":
    case "refused":
      return true;
    case "unverified":
    case "failed":
    case "settings":
    case "timed-out":
    case "no-provider":
      return false;
  }
}

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

/**
 * The send side of a staged sandbox (sandboxes plan D1, the critique's
 * two-phase handoff). Phase 1 creates or wakes the staged sandbox and waits
 * until it is ready, then pins the surface to it (`runStagedSandbox`). Phase
 * 2 runs here: once the surface's placement resolves to the new host, the
 * surface's own `submit` runs again, so the create, the by-hash upload and
 * the backstop run on the new host's client as for any host; then the stage
 * clears. `prepareHandoff` runs once before that resubmit (the landing
 * composer resets its workspace to the new host's empty one).
 *
 * `surfaceKey` `null` stages nothing (a request that named its host).
 *
 * `terminal` opens a folderless terminal on the new host from the line, in
 * the surface's epic; `null` where the surface has no epic to open it in.
 */
export function useStagedSandboxSend(input: {
  readonly surfaceKey: string | null;
  readonly resolvedHostId: string | null;
  readonly canSubmit: boolean;
  readonly submit: () => boolean;
  readonly prepareHandoff: (hostId: string) => void;
  readonly terminal: StagedSandboxTerminal | null;
  /** The task the surface is in, which the create names; `null` on landing. */
  readonly taskId: string | null;
  /**
   * The draft this composer holds, where the surface's stage is shared by
   * several (landing): the handoff resubmits only the one that sent.
   */
  readonly ownerId: string | null;
}): StagedSandboxSend {
  const {
    surfaceKey,
    resolvedHostId,
    canSubmit,
    submit,
    prepareHandoff,
    terminal,
    taskId,
    ownerId,
  } = input;
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const stage = useStagedSandbox(surfaceKey ?? "");
  const user = useAuthUser().data ?? null;
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const catalogue = useSandboxCatalogue(stage !== null).data ?? null;
  const verb = useSandboxVerb(stage?.createdSandboxId ?? "");
  const messageTextRef = useRef("");
  // The name the create falls back to, for the line to show meanwhile.
  const [fallbackName, setFallbackName] = useState(FALLBACK_NAME);

  const run = useCallback(
    (fresh: boolean): void => {
      if (surfaceKey === null || binding === null) return;
      void runStagedSandbox(
        surfaceKey,
        fresh,
        {
          fallbackName: stagedSandboxFallbackName(messageTextRef.current),
          taskId,
        },
        {
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
        },
      );
    },
    [binding, queryClient, surfaceKey, taskId, userId],
  );
  const newHost = useNewHostActions(
    stage?.createdHostId ?? null,
    terminal,
    run,
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
      // it is busy.
      if (current.phase === "staged" || current.failure !== null) {
        messageTextRef.current = messageText;
        setFallbackName(stagedSandboxFallbackName(messageText));
        useStagedSandboxStore
          .getState()
          .report(surfaceKey, { ownerId, terminalLaunch });
        // A send is a new create, with its own idempotency key, unless the
        // last one may have been accepted: then it repeats that one, as Retry
        // does.
        run(
          current.failure === null ||
            refusedBeforeCreate(current.failure, current.createdSandboxId),
        );
      }
      return true;
    },
    [ownerId, run, surfaceKey],
  );

  // Phase 2: the resubmit on the new host, once per handoff.
  const handedOffRef = useRef<string | null>(null);
  const preparedRef = useRef<string | null>(null);
  const handoffHostId =
    stage !== null && stage.phase === "handoff" && stage.ownerId === ownerId
      ? stage.createdHostId
      : null;
  const handoffStepAt = stage === null ? null : stage.stepAt;
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
      useStagedSandboxStore
        .getState()
        .report(surfaceKey, { stepAt: Date.now() });
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
    handoffStepAt,
    prepareHandoff,
    resolvedHostId,
    submit,
    surfaceKey,
  ]);

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
          onKeepWaiting: () => run(false),
          onCancel: () => useStagedSandboxStore.getState().cancel(surfaceKey),
          onChooseAnotherHost: () =>
            useStagedSandboxStore.getState().clear(surfaceKey),
          onRetryCreation: () => run(true),
          onRetry: () => run(false),
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
      if (createdHostId === null) return;
      repair.mutate({}, { onSuccess: () => run(false) });
    },
    onOpenTerminal:
      terminal === null || terminalTarget === null
        ? null
        : () => terminal.open(terminalTarget),
  };
}
