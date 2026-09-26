import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { Settings } from "lucide-react";
import type {
  ChatRunSettings,
  LastFailedAttempt,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatFallbackListTargetsResponse,
  FallbackActionOutcome,
  FallbackModelTarget,
  FallbackProfileTarget,
  FallbackRungRefusalDetail,
  FallbackTargetSkip,
} from "@traycer/protocol/host/chat-fallback";
import { tierRungSkipReasonSchema } from "@traycer/protocol/host/fallback-policy";
import type {
  ProviderId as WireProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  DEFAULT_PERMISSION,
  normalizeServiceTierForModel,
  type HarnessModelSelection,
  type ModelOption,
  type ProviderId,
  type ReasoningFallback,
  type ReasoningLevel,
} from "@/components/home/data/landing-options";
import {
  suggestionIsPick,
  type SuggestionRow,
  type SuggestionUsage,
} from "@/components/home/data/harness-model-search";
import {
  HarnessModelPicker,
  type HarnessModelPickerEmbedding,
  type HarnessModelPickerSuggestions,
} from "@/components/home/pickers/harness-model-picker";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type { ProfileDropdownUsageEntry } from "@/components/providers/profile-dropdown-usage";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGuiHarnessesQueryForClient,
  useGuiHarnessModelsQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProfileUsagePresentation } from "@/hooks/rate-limits/use-profile-usage-presentation";
import type { HostRpcRegistry } from "@/lib/host";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { formatWaitTime, useSampledNow } from "@/lib/relative-time";
import type { FallbackChoiceLease } from "@/stores/chats/chat-session-store";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
  type ComposerToolbarValues,
} from "@/stores/composer/composer-toolbar-store";
import {
  COUNTDOWN_NOT_PAUSED_LABEL,
  HOST_UNREACHABLE_LABEL,
  PAUSING_COUNTDOWN_LABEL,
  describeFallbackOutcome,
  describeListTargetsOutcome,
  describeManualRungRefusal,
  noSwitchDestinationText,
  switchConsequencesText,
  switchDestinationConsequence,
  type ManualRungKind,
} from "./fallback-copy";
import {
  fallbackDestinationOfModelTarget,
  fallbackDestinationOfTuple,
  fallbackDestinationSentence,
  fallbackHarnessLabelFor,
  fallbackKnownHarnessFor,
  fallbackProviderModelLabel,
  useFallbackModelLabels,
  useFallbackProfileLabels,
  type FallbackModelLabelResolver,
  type FallbackProfileLabelResolver,
} from "./fallback-identity";
import { useOpenFallbackSettings } from "./open-fallback-settings";
import {
  useFallbackChooseTarget,
  useFallbackRunManualRung,
} from "./use-fallback-actions";
import { useFallbackChoiceLease } from "./use-fallback-choice-lease";
import {
  useFallbackListTargets,
  type FallbackTargetSelector,
} from "./use-fallback-targets";
import { useChatLastFailedAttempt } from "./use-last-failed-attempt";
import { usePublishConfirmedManualFallbackAction } from "./use-confirmed-manual-action";
import { usePublishUnattendedFallbackOutcome } from "./use-unattended-fallback-outcome";

/**
 * Which card opened the chooser, and what it acts on.
 *
 * - `countdown`: the grace card. Opening it holds the countdown (the choice
 *   lease), and a switch is `chooseTarget` with the lease's token.
 * - `waiting`: the waiting card. Nothing to hold - a reset boundary is a fact,
 *   not a budget - so a switch is `chooseTarget` with no token.
 * - `failed-turn`: the transcript's error row. No traversal is live, so a
 *   switch is `runManualRung` bound to the failed attempt. `seedTuple` is the
 *   attempt's failed tuple, or the chat's own settings when the host did not
 *   name one.
 */
export type RoutingDestinationEntry =
  | { readonly kind: "countdown"; readonly pending: PendingFallback }
  | { readonly kind: "waiting"; readonly pending: PendingFallback }
  | {
      readonly kind: "failed-turn";
      readonly attempt: LastFailedAttempt;
      readonly seedTuple: ChatRunSettings;
    };

/**
 * What an effort the picked model does not advertise falls back to: the
 * model's own default, as in a composer. The chooser picks where the NEXT
 * turn runs, so it takes a composer's rule - not the judge's `"lowest"`, which
 * is the level its host runs an unset judge at.
 */
const ROUTING_REASONING_FALLBACK: ReasoningFallback = "model-default";

/** A rail click lands on the provider's catalog default, never on a memory. */
function routingProviderSwitchModel(): string {
  return "";
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The routing destination chooser: the composer's model picker, staged.
 *
 * One wrapper for the three places a user picks where a failed turn goes next
 * - the countdown card, the waiting card and the transcript's error row. It
 * owns everything the picker must not: the store, the catalog push, the hold,
 * the listing, the usage probes, the confirm footer and the verb.
 *
 * ## Staging, not writing
 *
 * The store is a standalone `"setting"` store with NO writer, and nothing here
 * ever installs one (`setOnSettingsChange` is never called). That is the whole
 * staging mechanism: a rail click, an account change, a row click, a ⌘-digit
 * or an effort change moves the store and nothing else. Only the footer's
 * confirm sends anything. `hostId: null` keeps every composer-memory write out
 * (`recordProfileSelection` drops it), so a pick made here never becomes the
 * model the next chat on that provider offers.
 *
 * ## The machine
 *
 * The catalog, the listing, the providers read and the verbs all go through
 * the TAB's host client, and the picker reads the same host as its run target
 * - so the store's catalog and the picker's own reads agree on the machine.
 * `hostId` (the chat session's host) keys only the session-store reads: the
 * lease, the live failed attempt and the announcer.
 */
export function RoutingDestinationPicker(props: {
  readonly entry: RoutingDestinationEntry;
  /**
   * The trigger's content: a label, or a whole destination - the countdown's
   * "to" chip is the trigger, glyph, emphasised segments and chevron included.
   */
  readonly triggerLabel: ReactNode;
  /**
   * The trigger's accessible name, where its content alone does not say what
   * it opens (a chip reading only a destination); `null` lets the content
   * name it.
   */
  readonly triggerAriaLabel: string | null;
  /**
   * How much weight the trigger carries: the card's one filled action
   * (`default`), a secondary one (`outline`), or the destination chip itself
   * (`route-chip`, which also takes the chip's size).
   */
  readonly triggerVariant: "default" | "outline" | "route-chip";
  /**
   * The trigger alone: a card in `switching`, or a row whose own rung is in
   * flight. Never the open popover - a pick answered while its surface is open
   * has to be answered on it.
   */
  readonly triggerDisabled: boolean;
  /** Whether this reader may steer the chat at all; gates every confirm. */
  readonly canAct: boolean;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}) {
  const { entry, epicId, chatId, hostId, canAct } = props;
  const tabHostId = useTabHostId();
  const client = useTabHostClient();
  const [open, setOpen] = useState(false);
  const seed = useStableValue(entrySeedTuple(entry), sameRunSettings);
  const { store, reseed } = useRoutingStore(seed);
  const countdown = entry.kind === "countdown" ? entry.pending : null;
  const listing = useRoutingListing({
    client,
    epicId,
    chatId,
    entry,
    seed,
    open,
  });
  const lease = useRoutingLease({ epicId, chatId, hostId, countdown, open });
  const liveAttempt = useChatLastFailedAttempt({ epicId, chatId, hostId });
  const attempt = useStableValue(entryAttempt(entry, liveAttempt), sameJson);
  const now = useSampledNow();
  const [unavailableIds, setUnavailableIds] =
    useState<ReadonlySet<string>>(NO_IDS);
  const [usage, setUsage] = useState<UsageByPair>(EMPTY_USAGE);
  const { data, failedTuple, labelFor, modelLabelFor } = listing;
  // Built only while open: nothing renders them otherwise, and a closed
  // chooser should not rebuild them on every countdown frame.
  const rows = useMemo(
    () =>
      open
        ? buildSuggestionRows({
            data,
            failedTuple,
            attempt,
            labelFor,
            modelLabelFor,
            now,
            usage: usage.entries,
            unavailableIds,
          })
        : NO_ROWS,
    [
      attempt,
      data,
      failedTuple,
      labelFor,
      modelLabelFor,
      now,
      open,
      unavailableIds,
      usage,
    ],
  );

  const [stagedRowId, setStagedRowId] = useState<string | null>(null);
  const stagedRow =
    stagedRowId === null
      ? null
      : (rows.find((row) => row.id === stagedRowId) ?? null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const preselect = usePreselectRecommended({
    store,
    reseed,
    seed,
    rows,
    ready: open && listing.fresh,
  });
  useClearStagedOnSelection(store, setStagedRowId);

  const { onOpened, onClosed, skipNextRelease } = lease;
  const { resetHeld } = listing;
  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      setRefusal(null);
      if (!next) {
        onClosed();
        return;
      }
      setStagedRowId(null);
      setUnavailableIds(NO_IDS);
      setUsage(EMPTY_USAGE);
      resetHeld();
      preselect.reset();
      reseed(seed);
      onOpened();
    },
    [onClosed, onOpened, preselect, reseed, resetHeld, seed],
  );

  const closeRef = useRef<(() => void) | null>(null);
  const openRef = useRef<(() => void) | null>(null);
  const hostLabel = useHostDirectoryEntry(hostId)?.label ?? null;
  const onAnswer = useCallback(
    (answer: RoutingAnswer, sentRowId: string | null) => {
      if (answer.outcome === "applied") {
        // The frame that follows is the feedback, and the traversal has
        // advanced - there is no frozen remainder left to hand back.
        skipNextRelease();
        closeRef.current?.();
        return;
      }
      setRefusal(answerRefusalText(answer, hostLabel));
      if (answer.outcome === "rung_target_unavailable" && sentRowId !== null) {
        setUnavailableIds((current) => new Set(current).add(sentRowId));
      }
    },
    [hostLabel, skipNextRelease],
  );
  const onTransportError = useCallback(() => {
    setRefusal(HOST_UNREACHABLE_LABEL);
  }, []);
  const verbs = useRoutingVerbs({
    client,
    epicId,
    chatId,
    hostId,
    open,
    onAnswer,
    onTransportError,
  });

  // Read at click time, through a ref, so the footer's button does not change
  // identity with every frame the countdown card receives.
  const confirm = (): void => {
    setRefusal(null);
    const request = routingRequestFor({
      entry,
      stagedRow,
      attempt,
      store,
      rows,
      failedTuple,
      leaseToken: lease.token,
    });
    if (request !== null) verbs.send(request);
  };
  const confirmRef = useRef(confirm);
  useEffect(() => {
    confirmRef.current = confirm;
  });
  const onConfirm = useCallback(() => {
    confirmRef.current();
  }, []);

  const openSettings = useOpenFallbackSettings(tabHostId);
  const heading = useMemo(
    () => (
      <SuggestedHeading
        state={headingState({
          data,
          isError: listing.isError,
          isFetching: listing.isFetching,
          rowCount: rows.length,
        })}
        emptyLine={`${noSwitchDestinationText(
          fallbackProviderModelLabel(failedTuple, modelLabelFor),
        )}. Pick any model below, or set up routing in Settings`}
        onOpenSettings={openSettings}
      />
    ),
    [
      data,
      failedTuple,
      listing.isError,
      listing.isFetching,
      modelLabelFor,
      openSettings,
      rows.length,
    ],
  );
  const suggestions = useMemo<HarnessModelPickerSuggestions>(
    () => ({
      heading,
      rows,
      stagedRowId: stagedRow === null ? null : stagedRow.id,
      onStageAction: (row) => {
        setStagedRowId(row === null ? null : row.id);
      },
      onHiddenByQuery: preselect.revert,
      reasoningFallback: ROUTING_REASONING_FALLBACK,
    }),
    [heading, preselect.revert, rows, stagedRow],
  );

  const footerStatus = statusLine({
    entry,
    countdownReady: lease.ready,
    refusedHold: lease.refused,
    now,
  });
  const footerRefusal =
    refusal ?? (lease.refused ? COUNTDOWN_NOT_PAUSED_LABEL : null);
  const footerAnnouncement = listingAnnouncement({
    open,
    data: listing.liveData,
    isError: listing.isError,
    isFetching: listing.isFetching,
    rows,
  });
  const queuedCount = entryQueuedCount(entry);
  const staged = stagedConsequence(stagedRow, now);
  const footer = useMemo(
    () => (
      <RoutingConfirmFooter
        store={store}
        failedTuple={failedTuple}
        rows={rows}
        labelFor={labelFor}
        modelLabelFor={modelLabelFor}
        queuedCount={queuedCount}
        stagedRow={stagedRow}
        stagedConsequence={staged}
        statusLine={footerStatus}
        refusal={footerRefusal}
        announcement={footerAnnouncement}
        canAct={canAct}
        countdownReady={lease.ready}
        busy={verbs.busy}
        onConfirm={onConfirm}
      />
    ),
    [
      canAct,
      failedTuple,
      footerAnnouncement,
      footerRefusal,
      footerStatus,
      labelFor,
      lease.ready,
      modelLabelFor,
      onConfirm,
      queuedCount,
      rows,
      staged,
      stagedRow,
      store,
      verbs.busy,
    ],
  );

  const { triggerAriaLabel, triggerDisabled, triggerLabel, triggerVariant } =
    props;
  const trigger = useMemo(
    () => (
      <Button
        size={triggerVariant === "route-chip" ? "route-chip" : "sm"}
        variant={triggerVariant}
        disabled={triggerDisabled || !canAct}
        aria-label={triggerAriaLabel ?? undefined}
      >
        {triggerLabel}
      </Button>
    ),
    [canAct, triggerAriaLabel, triggerDisabled, triggerLabel, triggerVariant],
  );
  const embedding = useMemo<HarnessModelPickerEmbedding>(
    () => ({
      trigger,
      providerSwitchModel: routingProviderSwitchModel,
      selectionMarked: true,
      openRef,
      closeRef,
      onOpenChange,
      suggestions,
      footer,
    }),
    [footer, onOpenChange, suggestions, trigger],
  );

  return (
    <>
      <RoutingCatalogSync store={store} client={client} open={open} />
      {open ? (
        <SuggestedUsageProbes
          rows={rows}
          client={client}
          runTargetHostId={tabHostId}
          onUsage={setUsage}
        />
      ) : null}
      <HarnessModelPicker
        store={store}
        withServiceTier={false}
        withReasoning
        tuiOnly={false}
        lockedHarnessId={null}
        // Never the trigger's gate: a surface that goes quiet while its answer
        // is in flight must stay open to give it.
        disabled={false}
        // Not the composer's toggle target: the model-picker shortcut and the
        // palette's "Change model…" belong to the chat's own composer.
        registerActivation={false}
        createProfileHostId={tabHostId}
        runTargetHostId={tabHostId}
        // No terminal to open a provider's setup session into from here; the
        // panel shows the steps without the button.
        terminalLoginSurface={null}
        labelDisplay="model-only"
        profileAdmission={null}
        embedding={embedding}
      />
    </>
  );
}

const NO_ROWS: ReadonlyArray<SuggestionRow> = [];

/* ------------------------------------------------------------------------- */
/* Listing                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The engine's destinations for this entry, asked for while open, and the
 * resolvers that name them.
 *
 * A revision bump (the countdown going `hold` -> `choosing`) is a new query
 * key, and a new key has no data: the previous answer stays on screen, with a
 * spinner in the heading, until the new one lands - rather than the section
 * collapsing to a skeleton on every transition. `fresh` is the gate for
 * anything that must not act on a stale answer (the preselect).
 */
function useRoutingListing(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly entry: RoutingDestinationEntry;
  readonly seed: ChatRunSettings;
  readonly open: boolean;
}) {
  const { client, epicId, chatId, entry, seed, open } = input;
  const selector = useStableValue(entrySelector(entry), sameJson);
  const targets = useFallbackListTargets(client, {
    epicId,
    chatId,
    selector,
    enabled: open,
  });
  const [held, setHeld] = useState(targets.data);
  if (targets.data !== undefined && targets.data !== held) {
    setHeld(targets.data);
  }
  const data = targets.data ?? held;
  const failedTuple = data?.failedTuple ?? seed;
  const labelFor = useFallbackProfileLabels(client, open);
  // Every harness a row can name: the failed tuple's, plus one per
  // equivalent-model row - the cross-provider rows are the point.
  const modelLabelFor = useFallbackModelLabels(
    client,
    [
      failedTuple.harnessId,
      ...(data === undefined
        ? []
        : data.modelTargets.map((target) => target.harnessId)),
    ],
    open,
  );
  const resetHeld = useCallback(() => {
    setHeld(undefined);
  }, []);
  return {
    data,
    liveData: targets.data,
    fresh: targets.data !== undefined && !targets.isFetching,
    isError: targets.isError,
    isFetching: targets.isFetching,
    failedTuple,
    labelFor,
    modelLabelFor,
    resetHeld,
  };
}

/* ------------------------------------------------------------------------- */
/* Verbs                                                                     */
/* ------------------------------------------------------------------------- */

/** What the confirm sends, by entry and by what is staged. */
type RoutingRequest =
  | {
      readonly kind: "rung";
      readonly rung: "retry" | "wait_once";
      readonly attempt: LastFailedAttempt;
    }
  | {
      readonly kind: "switch-attempt";
      readonly target: ChatRunSettings;
      readonly rowId: string | null;
      readonly attempt: LastFailedAttempt;
    }
  | {
      readonly kind: "choose";
      readonly traversalId: string;
      readonly revision: number;
      readonly target: ChatRunSettings;
      readonly rowId: string | null;
      readonly leaseToken: string | null;
    };

function routingRequestFor(input: {
  readonly entry: RoutingDestinationEntry;
  readonly stagedRow: SuggestionRow | null;
  readonly attempt: LastFailedAttempt | null;
  readonly store: ComposerToolbarStore;
  readonly rows: ReadonlyArray<SuggestionRow>;
  readonly failedTuple: ChatRunSettings;
  readonly leaseToken: string | null;
}): RoutingRequest | null {
  const { entry, stagedRow, attempt } = input;
  if (stagedRow !== null && stagedRow.action.kind !== "switch") {
    if (attempt === null) return null;
    return {
      kind: "rung",
      rung: stagedRow.action.kind === "retry" ? "retry" : "wait_once",
      attempt,
    };
  }
  const pick = confirmTarget(
    input.store.getState(),
    input.rows,
    input.failedTuple,
  );
  if (pick === null) return null;
  if (entry.kind === "failed-turn") {
    return {
      kind: "switch-attempt",
      target: pick.target,
      rowId: pick.rowId,
      attempt: entry.attempt,
    };
  }
  return {
    kind: "choose",
    traversalId: entry.pending.traversalId,
    revision: entry.pending.revision,
    target: pick.target,
    rowId: pick.rowId,
    // The token this chooser's own hold minted, on the countdown. The waiting
    // card holds nothing and says so: `null` is legal on the wire there.
    leaseToken: entry.kind === "countdown" ? input.leaseToken : null,
  };
}

/**
 * A verb's answer. A manual rung's carries the host's refusal detail and the
 * rung it answers, which the failed-turn card's own sentence is built from.
 */
type RoutingAnswer =
  | { readonly verb: "choose"; readonly outcome: FallbackActionOutcome }
  | {
      readonly verb: "manual";
      readonly outcome: FallbackActionOutcome;
      readonly detail: FallbackRungRefusalDetail | null;
      readonly rung: ManualRungKind;
    };

/**
 * The footer's line for a refused answer. A manual rung's is the failed-turn
 * card's own sentence (`describeManualRungRefusal`) - the host's reason and the
 * host's name included - so the chooser and the card never word one refusal
 * two ways; `null` where another surface already says it. A choose keeps its
 * outcome sentence.
 */
function answerRefusalText(
  answer: RoutingAnswer,
  hostLabel: string | null,
): string | null {
  if (answer.verb === "choose") return describeFallbackOutcome(answer.outcome);
  const copy = describeManualRungRefusal({
    outcome: answer.outcome,
    detail: answer.detail,
    rung: answer.rung,
    hostLabel,
  });
  return copy === null ? null : copy.text;
}

/**
 * The two verbs, and where their answers go.
 *
 * While the chooser is open its footer line is the channel (`inlineMenuOpen`),
 * through the per-call handlers here; once it has closed or gone, the
 * hook-level reporting takes over (the announcer for a switch, a toast for a
 * bare rung). A transport failure prints the same sentence the listing prints
 * when it cannot reach the host - one unreachable host is one fact.
 */
function useRoutingVerbs(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly open: boolean;
  readonly onAnswer: (answer: RoutingAnswer, sentRowId: string | null) => void;
  /** A request that got no response at all - every `outcome` is a response. */
  readonly onTransportError: () => void;
}) {
  const { client, epicId, chatId, hostId, open, onAnswer, onTransportError } =
    input;
  const publishUnattended = usePublishUnattendedFallbackOutcome({
    epicId,
    chatId,
    hostId,
  });
  const publishConfirmed = usePublishConfirmedManualFallbackAction({
    epicId,
    chatId,
    hostId,
  });
  const reporting = { inlineMenuOpen: open, publishUnattended };
  const chooseTarget = useFallbackChooseTarget(client, chatId, reporting);
  const runManualRung = useFallbackRunManualRung(
    client,
    chatId,
    publishConfirmed,
    reporting,
  );
  const send = (request: RoutingRequest): void => {
    switch (request.kind) {
      case "rung":
        runManualRung.mutate(
          {
            epicId,
            chatId,
            rung: request.rung,
            // `retry` is the same tuple again and `wait_once` parks on the
            // tuple that failed - only a switch carries a target.
            target: null,
            userMessageId: request.attempt.userMessageId,
            turnId: request.attempt.turnId,
          },
          {
            onSuccess: (response) => {
              onAnswer(
                {
                  verb: "manual",
                  outcome: response.outcome,
                  detail: response.detail,
                  rung: request.rung,
                },
                null,
              );
            },
            onError: onTransportError,
          },
        );
        return;
      case "switch-attempt":
        runManualRung.mutate(
          {
            epicId,
            chatId,
            rung: "switch",
            target: request.target,
            // BOTH ids, from the DTO: the reuse path re-sends one persisted
            // user message across retries, so the message id alone cannot tell
            // this attempt from its retry.
            userMessageId: request.attempt.userMessageId,
            turnId: request.attempt.turnId,
          },
          {
            onSuccess: (response) => {
              onAnswer(
                {
                  verb: "manual",
                  outcome: response.outcome,
                  detail: response.detail,
                  rung: "switch",
                },
                request.rowId,
              );
            },
            onError: onTransportError,
          },
        );
        return;
      case "choose":
        chooseTarget.mutate(
          {
            epicId,
            chatId,
            traversalId: request.traversalId,
            revision: request.revision,
            target: request.target,
            leaseToken: request.leaseToken,
          },
          {
            onSuccess: (response) => {
              onAnswer(
                { verb: "choose", outcome: response.outcome },
                request.rowId,
              );
            },
            onError: onTransportError,
          },
        );
        return;
    }
  };
  return {
    busy: chooseTarget.isPending || runManualRung.isPending,
    send,
  };
}

/* ------------------------------------------------------------------------- */
/* Entry                                                                     */
/* ------------------------------------------------------------------------- */

function entrySeedTuple(entry: RoutingDestinationEntry): ChatRunSettings {
  return entry.kind === "failed-turn"
    ? entry.seedTuple
    : entry.pending.failedTuple;
}

function entrySelector(entry: RoutingDestinationEntry): FallbackTargetSelector {
  if (entry.kind === "failed-turn") {
    return {
      kind: "attempt",
      userMessageId: entry.attempt.userMessageId,
      turnId: entry.attempt.turnId,
    };
  }
  return {
    kind: "traversal",
    traversalId: entry.pending.traversalId,
    revision: entry.pending.revision,
  };
}

/**
 * The failed attempt the Retry and Wait rows act on, read LIVE.
 *
 * The countdown takes the session's own `lastFailedAttempt`, which the host
 * defines during `hold` for the attempt the hold armed for, and no longer once
 * the window is frozen for choosing: the two rows appear while the countdown
 * runs and go when it pauses. The waiting card offers neither - it IS the
 * wait. The error row acts on the attempt it was drawn for.
 */
function entryAttempt(
  entry: RoutingDestinationEntry,
  liveAttempt: LastFailedAttempt | undefined,
): LastFailedAttempt | null {
  switch (entry.kind) {
    case "countdown":
      return liveAttempt ?? null;
    case "waiting":
      return null;
    case "failed-turn":
      return entry.attempt;
  }
}

/** The queue a switch moves; `null` where the host gives no count. */
function entryQueuedCount(entry: RoutingDestinationEntry): number | null {
  return entry.kind === "failed-turn" ? null : entry.pending.queuedItemsMoving;
}

/* ------------------------------------------------------------------------- */
/* Store                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The standalone toolbar store. Created once; every open re-seeds it from the
 * failed tuple under a fresh key (re-applying an unchanged key is a no-op by
 * design), so each open starts from the chat's own tuple.
 */
function useRoutingStore(seed: ChatRunSettings): {
  readonly store: ComposerToolbarStore;
  readonly reseed: (seed: ChatRunSettings) => void;
} {
  const generationRef = useRef(0);
  const [store] = useState(() =>
    createComposerToolbarStore({
      purpose: "setting",
      reasoningFallback: ROUTING_REASONING_FALLBACK,
      seedKey: seedKeyFor(seed, 0),
      values: seedValues(seed),
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    }),
  );
  const reseed = useCallback(
    (next: ChatRunSettings) => {
      generationRef.current += 1;
      store
        .getState()
        .applySeed(seedKeyFor(next, generationRef.current), seedValues(next));
    },
    [store],
  );
  return useMemo(() => ({ store, reseed }), [reseed, store]);
}

function seedKeyFor(seed: ChatRunSettings, generation: number): string {
  return JSON.stringify([seed, generation]);
}

/**
 * The store's values for a tuple. `permission` is inert: the picker draws no
 * permission control, and every tuple sent copies the failed tuple's own.
 */
function seedValues(seed: ChatRunSettings): ComposerToolbarValues {
  return {
    permission: DEFAULT_PERMISSION,
    selection: {
      harnessId: seed.harnessId,
      modelSlug: seed.model,
      profileId: seed.profileId,
    },
    reasoning: seed.reasoningEffort ?? "",
    serviceTier: seed.serviceTier ?? "",
  };
}

/**
 * Pushes the tab host's catalog into the store: every harness, and the models
 * of the store's own harness. The picker never pushes one; this is what lets a
 * provider switch resolve its `""` model to that provider's default.
 */
function RoutingCatalogSync({
  store,
  client,
  open,
}: {
  readonly store: ComposerToolbarStore;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly open: boolean;
}) {
  const harnessesQuery = useGuiHarnessesQueryForClient(client, {
    enabled: open,
    subscribed: open,
  });
  const harnesses = harnessesQuery.data?.harnesses;
  const harnessId = useStore(store, (state) => state.selection.harnessId);
  const available =
    harnesses?.find((row) => row.id === harnessId)?.available === true;
  const modelsQuery = useGuiHarnessModelsQueryForClient(
    client,
    harnessId,
    null,
    { enabled: open && available, subscribed: open },
  );
  const models = modelsQuery.data?.models;
  useEffect(() => {
    store.getState().setCatalog({
      hostId: null,
      chatLineCarriesAutoMode: null,
      harnesses,
      modelsHarnessId: harnessId,
      models: models ?? [],
      modelsLoaded: models !== undefined,
      tuiOnly: false,
    });
  }, [store, harnesses, harnessId, models]);
  return null;
}

/* ------------------------------------------------------------------------- */
/* Lease                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The countdown's hold, as the chooser drives it: hold on open, release on
 * close (unless the pick applied), re-ask when a frame retires it, release on
 * unmount. Lifted from the countdown card's old menu. For the waiting card
 * and the error row every verb here is a no-op and `ready` is true - there is
 * no clock to stop.
 *
 * `ready` is both halves of the rule a switch waits on: the host minted a
 * token AND the frame reports `choosing`. Either alone would let a pick land
 * while the countdown is still being spent - the race the lease exists to
 * prevent. `refused` says the host declined the hold; it is not evidence the
 * traversal advanced, and the chooser says only that the countdown was not
 * paused.
 */
function useRoutingLease(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly countdown: PendingFallback | null;
  readonly open: boolean;
}) {
  const { epicId, chatId, hostId, countdown, open } = input;
  const { lease, hold, release } = useFallbackChoiceLease({
    epicId,
    chatId,
    hostId,
  });
  const traversalId = countdown === null ? null : countdown.traversalId;
  const skipReleaseRef = useRef(false);
  useReaskHoldOnRetire({ open, lease, pending: countdown, hold });
  useReleaseOnUnmount(open && traversalId !== null, release);
  const onOpened = useCallback(() => {
    skipReleaseRef.current = false;
    if (traversalId !== null) hold(traversalId);
  }, [hold, traversalId]);
  // A plain `release()`: the session store owns the rest, because chooser
  // visibility and lease lifetime are different facts - a close that beats
  // the ack leaves the store owing the release, paid when the token lands.
  const onClosed = useCallback(() => {
    if (traversalId === null) return;
    if (skipReleaseRef.current) {
      skipReleaseRef.current = false;
      return;
    }
    release();
  }, [release, traversalId]);
  const skipNextRelease = useCallback(() => {
    skipReleaseRef.current = true;
  }, []);
  return {
    token: lease === null ? null : lease.token,
    ready:
      countdown === null ||
      (lease !== null &&
        lease.status === "held" &&
        countdown.state === "choosing"),
    refused: countdown !== null && lease !== null && lease.status === "refused",
    onOpened,
    onClosed,
    skipNextRelease,
  };
}

/**
 * Re-asks the hold when an authoritative frame retires the lease under an
 * OPEN chooser (a reconnect retires the old epoch's token).
 *
 * Only in `hold`: that is the one state with a clock running. `choosing`
 * means the host already froze the window, and a terminal state has none.
 * `pending` is a dependency as the whole object, and the DTO is replaced per
 * frame, so every frame re-evaluates the guards; between frames nothing moves,
 * so it cannot spin. `hold` only - a retired lease has no token to hand back.
 */
function useReaskHoldOnRetire(input: {
  readonly open: boolean;
  readonly lease: FallbackChoiceLease | null;
  readonly pending: PendingFallback | null;
  readonly hold: (traversalId: string) => void;
}): void {
  const { open, lease, pending, hold } = input;
  useEffect(() => {
    if (!open || pending === null) return;
    if (lease !== null) return;
    if (pending.state !== "hold") return;
    hold(pending.traversalId);
  }, [open, lease, pending, hold]);
}

/**
 * Hands the hold back when the chooser unmounts open - the one close it never
 * hears about. A released chat session stays warm for ten minutes, so closing
 * the tile over an open chooser would otherwise leave the host holding a
 * window with no UI anywhere to give it back.
 *
 * Latest-value refs, so the cleanup runs on unmount and on nothing else.
 */
function useReleaseOnUnmount(holding: boolean, release: () => void): void {
  const holdingRef = useRef(holding);
  const releaseRef = useRef(release);
  useEffect(() => {
    holdingRef.current = holding;
    releaseRef.current = release;
  });
  useEffect(
    () => () => {
      if (holdingRef.current) releaseRef.current();
    },
    [],
  );
}

/* ------------------------------------------------------------------------- */
/* Preselect and staging                                                     */
/* ------------------------------------------------------------------------- */

interface PreselectHandle {
  /** Forget this open's preselect; the next listing may make one. */
  readonly reset: () => void;
  /**
   * A query hid the section: put the store back on the failed tuple, if it
   * still holds the preselect - a pick the user made since is theirs - and
   * make no preselect for the rest of this open.
   */
  readonly revert: () => void;
}

/**
 * Commits the listing's recommended destination once per open, the first
 * time a fresh listing lands while the store is still on the failed tuple.
 *
 * Committed rather than only marked: the confirm sends what the store holds,
 * so a preselect the footer could not confirm would be a check mark with no
 * meaning. A user who has already moved the store keeps their pick.
 */
function usePreselectRecommended(input: {
  readonly store: ComposerToolbarStore;
  readonly reseed: (seed: ChatRunSettings) => void;
  readonly seed: ChatRunSettings;
  readonly rows: ReadonlyArray<SuggestionRow>;
  readonly ready: boolean;
}): PreselectHandle {
  const { store, reseed, seed, rows, ready } = input;
  const doneRef = useRef(false);
  const preselectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || doneRef.current) return;
    doneRef.current = true;
    const state = store.getState();
    if (!selectionIsTuple(state.values.selection, seed)) return;
    const recommended = rows.find(
      (row) =>
        row.recommended && row.selectable && row.action.kind === "switch",
    );
    if (recommended === undefined || recommended.action.kind !== "switch") {
      return;
    }
    commitSuggestion(store, recommended, recommended.action.target);
    preselectedRef.current = selectionKey(store.getState().values.selection);
  }, [ready, rows, seed, store]);

  const reset = useCallback(() => {
    doneRef.current = false;
    preselectedRef.current = null;
  }, []);
  const revert = useCallback(() => {
    // A query can arrive BEFORE the listing: the section is hidden, so no
    // preselect may land for the rest of this open - one committed later
    // would enable Switch for a destination nothing on screen shows.
    doneRef.current = true;
    const preselected = preselectedRef.current;
    preselectedRef.current = null;
    if (preselected === null) return;
    if (selectionKey(store.getState().values.selection) !== preselected) return;
    reseed(seed);
  }, [reseed, seed, store]);
  return useMemo(() => ({ reset, revert }), [reset, revert]);
}

/**
 * Any change to what the store holds replaces a staged Retry / Wait: a rail
 * click or an effort change is the user choosing a switch, and the footer must
 * not go on offering the action they moved away from.
 */
function useClearStagedOnSelection(
  store: ComposerToolbarStore,
  setStagedRowId: (next: string | null) => void,
): void {
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (
          state.values.selection !== previous.values.selection ||
          state.values.reasoning !== previous.values.reasoning
        ) {
          setStagedRowId(null);
        }
      }),
    [setStagedRowId, store],
  );
}

/**
 * The picker's own commit, for a suggestion chosen outside a click (the
 * preselect): selection, then the row's effort - always written, `""` for a
 * row that names none, exactly as a click writes it. The setting store keeps
 * its effort on a same-model commit, so a skipped write would leave the
 * row's model-default ask carrying whatever effort was set before.
 */
function commitSuggestion(
  store: ComposerToolbarStore,
  row: SuggestionRow,
  target: ChatRunSettings | null,
): void {
  store.getState().applyComposerSelection({
    selection: {
      harnessId: row.harnessId,
      modelSlug: row.modelId,
      profileId: row.profileId,
    },
    reasoning: "",
    serviceTier: "",
  });
  const effort = target === null ? null : target.reasoningEffort;
  store.getState().setReasoning(effort ?? "");
}

/* ------------------------------------------------------------------------- */
/* Confirm                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * What of the store the confirm reads: the pick, its derived effort, and the
 * catalog model it resolved to (for a null-effort row's default and the
 * fast-mode check). `ComposerToolbarState` is one.
 */
interface RoutingPick {
  readonly selection: HarnessModelSelection;
  readonly reasoning: ReasoningLevel;
  readonly selectedModel: ModelOption | null;
}

/**
 * What the confirm sends for the store's current pick.
 *
 * A pick equal to a selectable Suggested row - on (harness, model, account)
 * AND effort - sends that row's HOST-BUILT target unchanged: crossing
 * providers re-derives effort and fast mode against the destination's
 * catalog, and a client copy would drift from it. Anything else is a client
 * tuple: the store's (harness, model, account, effort) over the failed tuple,
 * whose permission and agent mode it keeps - never the chat composer's - and
 * its fast mode only where the picked model offers it.
 *
 * The row test is `suggestionIsPick`, the one the picker's check mark uses,
 * so the row that shows checked is the row whose target is sent; its effort
 * equality is EFFECTIVE (a row's `null` is the model's default under this
 * store's own fallback), never raw. Pure over a
 * {@link RoutingPick} rather than the store, so the footer can read back the
 * tuple its confirm would send - its sentence names it.
 *
 * `null` while the store's model is still resolving: a `""` model never
 * reaches the wire.
 */
function confirmTarget(
  pick: RoutingPick,
  rows: ReadonlyArray<SuggestionRow>,
  failedTuple: ChatRunSettings,
): { readonly target: ChatRunSettings; readonly rowId: string | null } | null {
  const { selection, reasoning } = pick;
  if (selection.modelSlug.length === 0) return null;
  const matching = rows.find((row) =>
    suggestionIsPick(row, {
      selection,
      reasoning,
      selectedModel: pick.selectedModel,
      reasoningFallback: ROUTING_REASONING_FALLBACK,
    }),
  );
  if (matching !== undefined && matching.action.kind === "switch") {
    const target = matching.action.target;
    if (target !== null) return { target, rowId: matching.id };
  }
  const effort = reasoning.length === 0 ? null : reasoning;
  const tier = normalizeServiceTierForModel(
    failedTuple.serviceTier ?? "",
    pick.selectedModel,
  ).trim();
  return {
    target: {
      ...failedTuple,
      harnessId: selection.harnessId,
      model: selection.modelSlug,
      profileId: selection.profileId,
      reasoningEffort: effort,
      serviceTier: tier.length === 0 ? null : tier,
    },
    rowId: null,
  };
}

function RoutingConfirmFooter({
  store,
  failedTuple,
  rows,
  labelFor,
  modelLabelFor,
  queuedCount,
  stagedRow,
  stagedConsequence,
  statusLine,
  refusal,
  announcement,
  canAct,
  countdownReady,
  busy,
  onConfirm,
}: {
  readonly store: ComposerToolbarStore;
  readonly failedTuple: ChatRunSettings;
  readonly rows: ReadonlyArray<SuggestionRow>;
  readonly labelFor: FallbackProfileLabelResolver;
  readonly modelLabelFor: FallbackModelLabelResolver;
  /** The queue a switch moves; `null` where the host gives no count. */
  readonly queuedCount: number | null;
  readonly stagedRow: SuggestionRow | null;
  readonly stagedConsequence: string | null;
  readonly statusLine: string | null;
  readonly refusal: string | null;
  readonly announcement: string;
  readonly canAct: boolean;
  readonly countdownReady: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}) {
  const selection = useStore(store, (state) => state.selection);
  const reasoning = useStore(store, (state) => state.reasoning);
  const selectedModel = useStore(store, (state) => state.selectedModel);
  // The RAW effort, not the derived one: the store clamps an effort the model
  // does not advertise, and a clamp is not the user choosing a new one. Every
  // open re-seeds this to the failed tuple's own value.
  const rawReasoning = useStore(store, (state) => state.values.reasoning);
  const moved =
    !selectionIsTuple(selection, failedTuple) ||
    rawReasoning !== (failedTuple.reasoningEffort ?? "");
  const action = footerAction(stagedRow, moved);
  // The sentence reads back the tuple the confirm would send - through the
  // same `confirmTarget` - so it moves with every row, account, provider and
  // effort change and can never name a place the button does not go.
  const consequence =
    action === "switch"
      ? switchConsequence({
          pick: confirmTarget(
            { selection, reasoning, selectedModel },
            rows,
            failedTuple,
          ),
          failedTuple,
          labelFor,
          modelLabelFor,
          queuedCount,
        })
      : stagedConsequence;
  const disabled =
    busy ||
    !canAct ||
    action === null ||
    (action === "switch" &&
      (!countdownReady || selection.modelSlug.length === 0));
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t px-2 py-1.5">
      {statusLine === null ? null : (
        <div className="text-ui-xs text-muted-foreground">{statusLine}</div>
      )}
      {consequence === null ? null : (
        <div className="text-ui-xs text-muted-foreground">{consequence}</div>
      )}
      {/*
       * The refusal, in ONE element that is both the visible line and the live
       * region: persistent and empty until there is something to say, because
       * a region mounted with its text announces nothing. `empty:sr-only`, not
       * `empty:hidden` - `display:none` would take the region out of the tree
       * for exactly as long as it had nothing to say.
       */}
      <div
        role="status"
        aria-live="polite"
        className="text-ui-xs text-warning-foreground empty:sr-only"
      >
        {refusal}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <div className="flex items-center justify-end">
        <Button size="sm" disabled={disabled} onClick={onConfirm}>
          {footerLabel(action)}
          {busy ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
    </div>
  );
}

/**
 * What a switch to the pick does, naming the destination (Flow 3's footer):
 * the destination as every fallback surface names it, the provider only when
 * the switch crosses providers, and the effort only when it differs from the
 * failed tuple's. The generic sentence stands in only while the store's model
 * is still resolving, when there is no tuple to name yet.
 */
function switchConsequence(input: {
  readonly pick: { readonly target: ChatRunSettings } | null;
  readonly failedTuple: ChatRunSettings;
  readonly labelFor: FallbackProfileLabelResolver;
  readonly modelLabelFor: FallbackModelLabelResolver;
  readonly queuedCount: number | null;
}): ReactNode {
  const { pick, failedTuple, queuedCount } = input;
  if (pick === null) return switchConsequencesText(queuedCount);
  const target = pick.target;
  const described = fallbackDestinationOfTuple(
    target,
    input.labelFor,
    input.modelLabelFor,
  );
  const effortMoved =
    trimmedEffort(target.reasoningEffort) !==
    trimmedEffort(failedTuple.reasoningEffort);
  const sentence = switchDestinationConsequence(
    fallbackDestinationSentence(
      { ...described, effortLabel: effortMoved ? described.effortLabel : null },
      target.harnessId !== failedTuple.harnessId,
    ),
    queuedCount,
  );
  return (
    <>
      {sentence.lead}{" "}
      <span className="font-medium text-foreground">
        {sentence.destination}
      </span>{" "}
      {sentence.trail}
    </>
  );
}

function trimmedEffort(effort: string | null): string {
  return (effort ?? "").trim();
}

function footerAction(
  stagedRow: SuggestionRow | null,
  moved: boolean,
): "switch" | "retry" | "wait" | null {
  if (stagedRow !== null && stagedRow.action.kind !== "switch") {
    return stagedRow.action.kind;
  }
  return moved ? "switch" : null;
}

function footerLabel(action: "switch" | "retry" | "wait" | null): string {
  switch (action) {
    case "retry":
      return "Retry";
    case "wait":
      return "Wait";
    case "switch":
    case null:
      return "Switch";
  }
}

/** What a staged Retry / Wait does, said before it is confirmed. */
function stagedConsequence(
  row: SuggestionRow | null,
  now: number,
): string | null {
  if (row === null) return null;
  switch (row.action.kind) {
    case "switch":
      return null;
    case "retry":
      return "Runs this message again on the same account and model.";
    case "wait":
      return `Waits until ${formatWaitTime(row.action.resetsAt, now)}, then runs this message on the same account and model.`;
  }
}

/**
 * The line under the list that says what is happening behind the chooser.
 *
 * The countdown says it is PAUSING until the host has both minted a token and
 * reported `choosing` - never "paused" while the clock still runs. A refused
 * hold says nothing here: the refusal line carries it. The waiting card says
 * when the wait ends if nothing is picked, because no number is ticking down
 * to make that obvious.
 */
function statusLine(input: {
  readonly entry: RoutingDestinationEntry;
  readonly countdownReady: boolean;
  readonly refusedHold: boolean;
  readonly now: number;
}): string | null {
  const { entry, countdownReady, refusedHold, now } = input;
  switch (entry.kind) {
    case "countdown":
      if (refusedHold) return null;
      return countdownReady
        ? "Countdown paused while you choose."
        : PAUSING_COUNTDOWN_LABEL;
    case "waiting":
      return entry.pending.deadline === null
        ? null
        : `Resumes at ${formatWaitTime(entry.pending.deadline, now)} unless you pick something.`;
    case "failed-turn":
      return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Suggested rows                                                            */
/* ------------------------------------------------------------------------- */

type UsageKey = string;

/** Joins usage keys into one memo-stable string; never inside a key. */
const PAIR_SEPARATOR = "\u0001";

function usageKey(harnessId: string, profileId: string | null): UsageKey {
  return `${harnessId}\u0000${profileId ?? ""}`;
}

interface UsageByPair {
  /** Per-harness signature of what was reported, so an unchanged report is a no-op. */
  readonly signatures: ReadonlyMap<ProviderId, string>;
  readonly entries: ReadonlyMap<UsageKey, SuggestionUsage>;
}

const EMPTY_USAGE: UsageByPair = {
  signatures: new Map(),
  entries: new Map(),
};

/**
 * The Suggested rows, in the order they are offered: sibling accounts on the
 * failed provider, equivalent models on others, then waiting and retrying on
 * the account that failed.
 *
 * Two rules from the old menu stand. `rate-limited` is CURRENT evidence the
 * destination is dead and dims the row; `already-tried` is a fact about this
 * traversal, not the destination, and stays selectable. A row the host
 * answered `rung_target_unavailable` for is dimmed for the rest of the open.
 *
 * An equivalent model on a harness this build does not know is dropped: it
 * cannot be named, iconed or committed to the store.
 */
function buildSuggestionRows(input: {
  readonly data: ChatFallbackListTargetsResponse | undefined;
  readonly failedTuple: ChatRunSettings;
  readonly attempt: LastFailedAttempt | null;
  readonly labelFor: FallbackProfileLabelResolver;
  readonly modelLabelFor: FallbackModelLabelResolver;
  readonly now: number;
  readonly usage: ReadonlyMap<UsageKey, SuggestionUsage>;
  readonly unavailableIds: ReadonlySet<string>;
}): ReadonlyArray<SuggestionRow> {
  const { data, failedTuple, attempt, labelFor, modelLabelFor, now, usage } =
    input;
  const rows: SuggestionRow[] = [];
  const usageFor = (harnessId: string, profileId: string | null) =>
    usage.get(usageKey(harnessId, profileId)) ?? NO_USAGE;
  const failedModelLabel = fallbackProviderModelLabel(
    failedTuple,
    modelLabelFor,
  );
  if (data !== undefined && data.outcome === "listed") {
    for (const target of data.profileTargets) {
      rows.push(
        profileSuggestion({
          target,
          failedTuple,
          subtitle: failedModelLabel,
          labelFor,
          usage: usageFor(failedTuple.harnessId, target.profileId),
          unavailableIds: input.unavailableIds,
        }),
      );
    }
    for (const target of data.modelTargets) {
      const row = modelSuggestion({
        target,
        failedTuple,
        labelFor,
        modelLabelFor,
        usage: usageFor(target.harnessId, target.profileId),
        unavailableIds: input.unavailableIds,
      });
      if (row !== null) rows.push(row);
    }
  }
  // The host's eligible rungs alone decide Retry and Wait - a sign-out
  // included (Flow 4: Retry leads for any cause but a rate limit or a billing
  // stop), so this section agrees with the failed-turn card beside it.
  if (attempt !== null) {
    const account = labelFor(failedTuple.profileId);
    const resetsAt = attempt.failure.resetsAt;
    if (attempt.eligibleRungs.includes("wait_once") && resetsAt !== undefined) {
      rows.push(
        actionSuggestion({
          id: "action:wait",
          failedTuple,
          title: `Wait until ${formatWaitTime(resetsAt, now)}`,
          subtitle: `${failedModelLabel} on ${account}`,
          usage: usageFor(failedTuple.harnessId, failedTuple.profileId),
          action: { kind: "wait", resetsAt },
        }),
      );
    }
    if (attempt.eligibleRungs.includes("retry")) {
      rows.push(
        actionSuggestion({
          id: "action:retry",
          failedTuple,
          title: `Try ${account} again`,
          subtitle: failedModelLabel,
          usage: usageFor(failedTuple.harnessId, failedTuple.profileId),
          action: { kind: "retry" },
        }),
      );
    }
  }
  return withRecommendation(rows);
}

/**
 * Flow 3's default: the first USABLE row in routing order is Recommended, and
 * so is what the chooser preselects.
 *
 * The host's pick among the sibling accounts stands while it is usable. When
 * it is not - every sibling dimmed, or no sibling at all and only equivalent
 * models listed - the first usable switch row takes it, so a listing of one
 * usable model still has a default for Enter to confirm. A dimmed row never
 * keeps the badge: Recommended on a row that cannot be picked would point the
 * user at a dead end.
 */
function withRecommendation(
  rows: ReadonlyArray<SuggestionRow>,
): ReadonlyArray<SuggestionRow> {
  const usable = (row: SuggestionRow): boolean =>
    row.selectable && row.action.kind === "switch";
  const pick =
    rows.find((row) => row.recommended && usable(row)) ?? rows.find(usable);
  return rows.map((row) => {
    const recommended = row === pick;
    return row.recommended === recommended ? row : { ...row, recommended };
  });
}

const NO_USAGE: SuggestionUsage = { kind: "none" };

/** The one note a destination the host just refused carries for this open. */
const UNAVAILABLE_NOTE = "Not available right now.";

/**
 * A sibling ACCOUNT on the failed tuple's own provider. The only row whose
 * tuple is built here rather than by the engine, and it is exact: only the
 * account moves, so nothing is left for the engine to re-derive.
 */
function profileSuggestion(input: {
  readonly target: FallbackProfileTarget;
  readonly failedTuple: ChatRunSettings;
  readonly subtitle: string;
  readonly labelFor: FallbackProfileLabelResolver;
  readonly usage: SuggestionUsage;
  readonly unavailableIds: ReadonlySet<string>;
}): SuggestionRow {
  const { target, failedTuple } = input;
  const id = `profile:${target.profileId ?? "ambient"}`;
  const unavailable = input.unavailableIds.has(id);
  const label = target.label.trim();
  return {
    kind: "suggestion",
    id,
    harnessId: failedTuple.harnessId,
    modelId: failedTuple.model,
    profileId: target.profileId,
    title: label.length > 0 ? label : input.labelFor(target.profileId),
    subtitle: input.subtitle,
    note: unavailable ? UNAVAILABLE_NOTE : (target.skip?.label ?? null),
    usage: input.usage,
    selectable:
      target.selectable &&
      !unavailable &&
      !skipIsCurrentDeadEvidence(target.skip),
    recommended: target.recommended,
    action: {
      kind: "switch",
      target: { ...failedTuple, profileId: target.profileId },
    },
  };
}

/** An equivalent model - on another provider, or another effort. */
function modelSuggestion(input: {
  readonly target: FallbackModelTarget;
  readonly failedTuple: ChatRunSettings;
  readonly labelFor: FallbackProfileLabelResolver;
  readonly modelLabelFor: FallbackModelLabelResolver;
  readonly usage: SuggestionUsage;
  readonly unavailableIds: ReadonlySet<string>;
}): SuggestionRow | null {
  const { target, failedTuple } = input;
  const harnessId = fallbackKnownHarnessFor(target.harnessId);
  if (harnessId === null) return null;
  const id = `model:${target.groupId}:${target.harnessId}:${target.model ?? target.modelFamily}:${target.reasoningEffort ?? "default"}:${target.profileId ?? "ambient"}`;
  const unavailable = input.unavailableIds.has(id);
  const destination = fallbackDestinationOfModelTarget(
    target,
    input.labelFor,
    input.modelLabelFor,
  );
  const crossesProviders = harnessId !== failedTuple.harnessId;
  const notes = [
    unavailable ? UNAVAILABLE_NOTE : (target.skip?.label ?? null),
    ...target.warnings,
  ].filter((note): note is string => note !== null);
  return {
    kind: "suggestion",
    id,
    harnessId,
    modelId: target.target?.model ?? target.model ?? target.modelFamily,
    profileId: target.profileId,
    title: [destination.modelLabel, destination.effortLabel]
      .filter((part): part is string => part !== null)
      .join(" · "),
    subtitle: crossesProviders
      ? `${fallbackHarnessLabelFor(target.harnessId)} · ${destination.profileLabel}`
      : destination.profileLabel,
    note: notes.length === 0 ? null : notes.join(" "),
    usage: input.usage,
    selectable:
      target.target !== null &&
      !unavailable &&
      !skipIsCurrentDeadEvidence(target.skip),
    recommended: false,
    action: { kind: "switch", target: target.target },
  };
}

function actionSuggestion(input: {
  readonly id: string;
  readonly failedTuple: ChatRunSettings;
  readonly title: string;
  readonly subtitle: string;
  readonly usage: SuggestionUsage;
  readonly action: SuggestionRow["action"];
}): SuggestionRow {
  return {
    kind: "suggestion",
    id: input.id,
    harnessId: input.failedTuple.harnessId,
    modelId: input.failedTuple.model,
    profileId: input.failedTuple.profileId,
    title: input.title,
    subtitle: input.subtitle,
    note: null,
    usage: input.usage,
    selectable: true,
    recommended: false,
    action: input.action,
  };
}

/**
 * Whether a skip reason is CURRENT evidence the destination is dead. Only
 * `rate-limited` is; an unrecognised reason degrades to selectable rather than
 * to a policy invented from a word this build does not know.
 */
function skipIsCurrentDeadEvidence(skip: FallbackTargetSkip | null): boolean {
  if (skip === null) return false;
  const parsed = tierRungSkipReasonSchema.safeParse(skip.reason);
  return parsed.success && parsed.data === "rate-limited";
}

/* ------------------------------------------------------------------------- */
/* Heading                                                                   */
/* ------------------------------------------------------------------------- */

type HeadingState =
  | { readonly kind: "loading" }
  | { readonly kind: "refetching" }
  | { readonly kind: "ready" }
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "empty" };

function headingState(input: {
  readonly data: ChatFallbackListTargetsResponse | undefined;
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly rowCount: number;
}): HeadingState {
  const { data, isError, isFetching, rowCount } = input;
  if (data === undefined) {
    return isError
      ? { kind: "line", text: HOST_UNREACHABLE_LABEL }
      : { kind: "loading" };
  }
  if (isFetching) return { kind: "refetching" };
  const moved = describeListTargetsOutcome(data.outcome);
  if (moved !== null) return { kind: "line", text: moved };
  return rowCount === 0 ? { kind: "empty" } : { kind: "ready" };
}

function SuggestedHeading({
  state,
  emptyLine,
  onOpenSettings,
}: {
  readonly state: HeadingState;
  readonly emptyLine: string;
  readonly onOpenSettings: () => void;
}) {
  switch (state.kind) {
    case "loading":
      return (
        <div className="flex flex-col gap-1">
          <SuggestedTitle trailing={null} />
          <Skeleton className="h-9 w-full" />
        </div>
      );
    case "refetching":
      return (
        <SuggestedTitle
          trailing={
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          }
        />
      );
    case "ready":
      return <SuggestedTitle trailing={null} />;
    case "line":
      return (
        <div className="px-1 text-ui-xs text-muted-foreground">
          {state.text}
        </div>
      );
    case "empty":
      return (
        <div className="flex items-start gap-1 px-1">
          <span className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
            {emptyLine}
          </span>
          <Button
            size="icon-xs"
            variant="muted"
            aria-label="Open model routing settings"
            onClick={onOpenSettings}
          >
            <Settings aria-hidden />
          </Button>
        </div>
      );
  }
}

function SuggestedTitle({ trailing }: { readonly trailing: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 text-overline font-medium uppercase text-muted-foreground/70">
      <span>Suggested</span>
      {trailing}
    </div>
  );
}

/**
 * What the listing has SETTLED on, for the sr-only live region: a failure, a
 * moved-on chat, or a count of what can be chosen. `""` while nothing has
 * settled - a spinner is not a result, and an announcement per intermediate
 * state makes the real answer the third thing heard rather than the first.
 * Counts SELECTABLE rows, so it cannot contradict the dimmed rows under it.
 */
function listingAnnouncement(input: {
  readonly open: boolean;
  readonly data: ChatFallbackListTargetsResponse | undefined;
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly rows: ReadonlyArray<SuggestionRow>;
}): string {
  const { open, data, isError, isFetching, rows } = input;
  if (!open || isFetching) return "";
  if (isError || data === undefined)
    return isError ? HOST_UNREACHABLE_LABEL : "";
  const moved = describeListTargetsOutcome(data.outcome);
  if (moved !== null) return moved;
  const selectable = rows.filter((row) => row.selectable).length;
  if (selectable === 0) return "No suggested destinations are available.";
  return selectable === 1
    ? "1 suggested destination available."
    : `${selectable} suggested destinations available.`;
}

/* ------------------------------------------------------------------------- */
/* Usage                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * One usage probe per provider the Suggested rows name, mounted while the
 * chooser is open. `useProfileUsagePresentation` answers for one provider at a
 * time, so the probes are components rather than a loop of hooks, and each
 * reports its cells up.
 */
function SuggestedUsageProbes({
  rows,
  client,
  runTargetHostId,
  onUsage,
}: {
  readonly rows: ReadonlyArray<SuggestionRow>;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly runTargetHostId: string;
  readonly onUsage: (update: (current: UsageByPair) => UsageByPair) => void;
}) {
  const providers = useProvidersListForClient(client, {
    enabled: true,
    subscribed: true,
  });
  const pairsKey = [
    ...new Set(rows.map((row) => usageKey(row.harnessId, row.profileId))),
  ]
    .sort()
    .join(PAIR_SEPARATOR);
  const groups = useMemo(
    () =>
      probeGroups(
        pairsKey,
        providers.data === undefined ? null : providers.data.providers,
      ),
    [pairsKey, providers.data],
  );
  return groups.map((group) => (
    <ProviderUsageProbe
      key={group.harnessId}
      group={group}
      runTargetHostId={runTargetHostId}
      onUsage={onUsage}
    />
  ));
}

interface ProbeGroup {
  readonly harnessId: ProviderId;
  readonly providerId: WireProviderId;
  readonly profiles: ReadonlyArray<ProviderProfile>;
}

type ProvidersListRows = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>["providers"];

/**
 * The (provider, profiles) groups the probes ask about, from the rows' pairs.
 * A pair whose account the providers read does not list gets no probe and no
 * usage cell - there is no gauge to read for it.
 */
function probeGroups(
  pairsKey: string,
  providers: ProvidersListRows | null,
): ReadonlyArray<ProbeGroup> {
  if (providers === null) return [];
  const pairs = new Set(pairsKey.split(PAIR_SEPARATOR));
  const groups: ProbeGroup[] = [];
  for (const provider of providers) {
    const harness = providerIdToGuiHarnessId(provider.providerId);
    const profiles = provider.profiles.filter((profile) =>
      pairs.has(usageKey(harness, profileCommitId(profile))),
    );
    if (profiles.length === 0) continue;
    groups.push({
      harnessId: harness,
      providerId: provider.providerId,
      profiles,
    });
  }
  return groups;
}

/**
 * Asks each suggested account for fresh usage ONCE per open, and reports the
 * cells: "Checking usage…" until the check answers, the reading when there is
 * one, and "Not checked" with a way to ask again only when the check came back
 * with nothing to show. `ensureFresh` is the non-forced check - it skips a
 * still-fresh cache and never re-trips a provider's own floors.
 */
function ProviderUsageProbe({
  group,
  runTargetHostId,
  onUsage,
}: {
  readonly group: ProbeGroup;
  readonly runTargetHostId: string;
  readonly onUsage: (update: (current: UsageByPair) => UsageByPair) => void;
}) {
  const presentation = useProfileUsagePresentation({
    runTargetHostId,
    providerId: group.providerId,
    profiles: group.profiles,
  });
  const askedRef = useRef(new Set<string | null>());
  const [settled, setSettled] = useState<ReadonlySet<string | null>>(
    () => new Set(),
  );
  useEffect(() => {
    if (!presentation.isHostReady) return;
    presentation.entries.forEach((entry, profileId) => {
      if (askedRef.current.has(profileId)) return;
      askedRef.current.add(profileId);
      void entry.ensureFresh().finally(() => {
        setSettled((current) => new Set(current).add(profileId));
      });
    });
  }, [presentation]);

  const latestRef = useRef(presentation.entries);
  useEffect(() => {
    latestRef.current = presentation.entries;
  });
  const harnessId = group.harnessId;
  useEffect(() => {
    const cells = new Map<UsageKey, SuggestionUsage>();
    const signature: string[] = [];
    presentation.entries.forEach((entry, profileId) => {
      const cell = usageCell(entry, settled.has(profileId), () => {
        void latestRef.current.get(profileId)?.refresh();
      });
      cells.set(usageKey(harnessId, profileId), cell);
      signature.push(usageSignature(profileId, cell));
    });
    const key = signature.join("|");
    onUsage((current) => {
      if (current.signatures.get(harnessId) === key) return current;
      const entries = new Map(current.entries);
      for (const [pair] of entries) {
        if (pair.startsWith(`${harnessId}\u0000`)) entries.delete(pair);
      }
      cells.forEach((cell, pair) => entries.set(pair, cell));
      return {
        signatures: new Map(current.signatures).set(harnessId, key),
        entries,
      };
    });
  }, [harnessId, onUsage, presentation.entries, settled]);
  return null;
}

function usageCell(
  entry: ProfileDropdownUsageEntry,
  settled: boolean,
  onRefresh: () => void,
): SuggestionUsage {
  const reading =
    entry.projection.kind === "detail" ||
    entry.projection.kind === "stale" ||
    entry.projection.kind === "semantic_only";
  if (!entry.fetchEligible) {
    return reading ? { kind: "reading", entry } : NO_USAGE;
  }
  if (!settled || entry.refreshStatus === "refreshing") {
    return { kind: "checking" };
  }
  if (reading) return { kind: "reading", entry };
  return { kind: "not-checked", onRefresh };
}

function usageSignature(
  profileId: string | null,
  cell: SuggestionUsage,
): string {
  if (cell.kind !== "reading") return `${profileId ?? ""}:${cell.kind}`;
  const projection = cell.entry.projection;
  const used =
    projection.compactWindow === null
      ? ""
      : String(projection.compactWindow.window.usedPercent);
  return `${profileId ?? ""}:${projection.kind}:${projection.severity}:${used}:${projection.checkedAt ?? ""}`;
}

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

function selectionIsTuple(
  selection: {
    readonly harnessId: string;
    readonly modelSlug: string;
    readonly profileId: string | null;
  },
  tuple: ChatRunSettings,
): boolean {
  return (
    selection.harnessId === tuple.harnessId &&
    selection.modelSlug === tuple.model &&
    selection.profileId === tuple.profileId
  );
}

function selectionKey(selection: {
  readonly harnessId: string;
  readonly modelSlug: string;
  readonly profileId: string | null;
}): string {
  return JSON.stringify([
    selection.harnessId,
    selection.modelSlug,
    selection.profileId,
  ]);
}

function sameRunSettings(a: ChatRunSettings, b: ChatRunSettings): boolean {
  return (
    a.harnessId === b.harnessId &&
    a.model === b.model &&
    a.permissionMode === b.permissionMode &&
    a.reasoningEffort === b.reasoningEffort &&
    a.serviceTier === b.serviceTier &&
    a.agentMode === b.agentMode &&
    a.profileId === b.profileId
  );
}

/**
 * A value kept by identity while `same` says it is unchanged. The countdown's
 * DTO is replaced on every frame, and a new object per tick would rebuild
 * every memo downstream of it - and the picker with them - once a second.
 */
function useStableValue<T>(value: T, same: (a: T, b: T) => boolean): T {
  const [held, setHeld] = useState(value);
  if (same(held, value)) return held;
  setHeld(value);
  return value;
}

function sameJson<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
