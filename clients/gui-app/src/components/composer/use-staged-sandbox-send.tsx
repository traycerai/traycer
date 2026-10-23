import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SandboxSetupLine } from "@/components/composer/sandbox-setup-line";
import { openStagedShapeSheet } from "@/components/composer/use-sandbox-staging";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { useHostBinding } from "@/lib/host";
import {
  priceClause,
  stageBalanceMc,
  stageNeedsCredits,
  stagePrice,
  stageProviderFor,
} from "@/lib/sandboxes/sandbox-stage-model";
import { sandboxShapeLabel } from "@/lib/sandboxes/sandbox-strings";
import { startSandboxWake } from "@/lib/sandboxes/sandbox-wake";
import { runStagedSandbox } from "@/lib/sandboxes/staged-sandbox-run";
import {
  readStagedSandbox,
  useStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";

/** A sandbox's name when the shape sheet set none: the message's first words. */
const FALLBACK_NAME_WORDS = 4;
const FALLBACK_NAME = "sandbox";

export function stagedSandboxFallbackName(text: string): string {
  const slug = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, FALLBACK_NAME_WORDS)
    .join("-");
  return slug.length === 0 ? FALLBACK_NAME : slug;
}

export interface StagedSandboxSend {
  /**
   * Called first by the surface's submit. `true` when the stage took the
   * send (phase 1 started, or is already running): the surface submits
   * nothing and keeps the draft. `false` when nothing is staged, or the stage
   * is in its handoff and the surface's own submit should run.
   */
  readonly intercept: (messageText: string) => boolean;
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
 */
export function useStagedSandboxSend(input: {
  readonly surfaceKey: string | null;
  readonly resolvedHostId: string | null;
  readonly canSubmit: boolean;
  readonly submit: () => boolean;
  readonly prepareHandoff: (hostId: string) => void;
}): StagedSandboxSend {
  const { surfaceKey, resolvedHostId, canSubmit, submit, prepareHandoff } =
    input;
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const stage = useStagedSandbox(surfaceKey ?? "");
  const user = useAuthUser().data ?? null;
  const catalogue = useSandboxCatalogue(stage !== null).data ?? null;
  const verb = useSandboxVerb(stage?.createdSandboxId ?? "");
  const messageTextRef = useRef("");

  const run = useCallback(
    (fresh: boolean): void => {
      if (surfaceKey === null || binding === null) return;
      void runStagedSandbox(
        surfaceKey,
        fresh,
        stagedSandboxFallbackName(messageTextRef.current),
        {
          auth: binding.auth,
          directory: binding.directory,
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
    [binding, queryClient, surfaceKey],
  );

  const intercept = useCallback(
    (messageText: string): boolean => {
      if (surfaceKey === null) return false;
      const current = readStagedSandbox(surfaceKey);
      if (current === null || current.phase === "handoff") return false;
      if (current.phase === "staged") {
        messageTextRef.current = messageText;
        run(false);
      }
      return true;
    },
    [run, surfaceKey],
  );

  // Phase 2: the resubmit on the new host, once per handoff.
  const handedOffRef = useRef<string | null>(null);
  const preparedRef = useRef<string | null>(null);
  const handoffHostId =
    stage !== null && stage.phase === "handoff" ? stage.createdHostId : null;
  const handoffStepAt = stage === null ? null : stage.stepAt;
  useEffect(() => {
    if (surfaceKey === null || handoffHostId === null) return;
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
    // Accepted or refused, the stage is done: a refusal is the composer's own
    // inline notice, and the draft stays for the next send on this host.
    submit();
    useStagedSandboxStore.getState().clear(surfaceKey);
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
      // Only the smallest shape is priced: a larger staged shape has a
      // smaller one the balance covers when it covers the smallest's hour.
      smallerShapeAffordable:
        price !== null &&
        !price.exact &&
        !stageNeedsCredits(stageBalanceMc(user, configuration), price),
    };
  }, [catalogue, stage, user]);

  const line =
    surfaceKey === null || stage === null || facts === null ? null : (
      <SandboxSetupLine
        stage={stage}
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
          // The verdict is read again; the repair itself is the sandbox's
          // own, on its card.
          onRetryApplying: () => run(false),
          onStop: () => {
            if (stage.createdSandboxId !== null) verb.mutate("stop");
            useStagedSandboxStore.getState().clear(surfaceKey);
          },
          onOpenTerminalInstead: null,
          onOpenProviders: null,
        }}
      />
    );

  return { intercept, line };
}
