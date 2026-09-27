import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useStore } from "zustand";
import type {
  ChatRunSettings,
  LastFailedAttempt,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatFallbackListTargetsResponse,
  FallbackActionOutcome,
  FallbackRungRefusalDetail,
  FallbackTargetSkip,
} from "@traycer/protocol/host/chat-fallback";
import { tierRungSkipReasonSchema } from "@traycer/protocol/host/fallback-policy";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  DEFAULT_PERMISSION,
  modelDisplayLabel,
  normalizeReasoningForModel,
  normalizeServiceTierForModel,
  type HarnessModelSelection,
  type ModelOption,
  type ReasoningFallback,
  type ReasoningLevel,
} from "@/components/home/data/landing-options";
import {
  HarnessModelPicker,
  type HarnessModelPickerEmbedding,
} from "@/components/home/pickers/harness-model-picker";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  useGuiHarnessesQueryForClient,
  useGuiHarnessModelsQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import type { FallbackChoiceLease } from "@/stores/chats/chat-session-store";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
  type ComposerToolbarValues,
} from "@/stores/composer/composer-toolbar-store";
import {
  COUNTDOWN_NOT_PAUSED_LABEL,
  HOST_UNREACHABLE_LABEL,
  describeFallbackOutcome,
  describeManualRungRefusal,
  routingSwitchLine,
  type ManualRungKind,
} from "./fallback-copy";
import {
  fallbackDestinationOfTuple,
  useFallbackModelLabels,
  useFallbackProfileLabels,
  type FallbackModelLabelResolver,
  type FallbackProfileLabelResolver,
} from "./fallback-identity";
import {
  useFallbackChooseTarget,
  useFallbackRunManualRung,
} from "./use-fallback-actions";
import { useFallbackChoiceLease } from "./use-fallback-choice-lease";
import {
  useFallbackListTargets,
  type FallbackTargetSelector,
} from "./use-fallback-targets";
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

/**
 * The routing destination chooser: the composer's model picker, staged.
 *
 * One wrapper for the three places a user picks where a failed turn goes next
 * - the countdown card, the waiting card and the transcript's error row. The
 * picker is the composer's own and nothing else - its search, rail, account
 * dropdown, rows and effort control - with one footer line under it saying
 * where Switch replays the message. This wrapper owns everything the picker
 * must not: the store, the catalog push, the hold, the listing, the footer and
 * the verb.
 *
 * ## Staging, not writing
 *
 * The store is a standalone `"setting"` store with NO writer, and nothing here
 * ever installs one (`setOnSettingsChange` is never called). That is the whole
 * staging mechanism: a rail click, an account change, a row click, a ⌘-digit
 * or an effort change moves the store and nothing else. Only the footer's
 * Switch sends anything. `hostId: null` keeps every composer-memory write out
 * (`recordProfileSelection` drops it), so a pick made here never becomes the
 * model the next chat on that provider offers.
 *
 * ## Opening on the recommendation
 *
 * The store is seeded from the listing's recommended account - the failed
 * tuple itself when the host recommends none - BEFORE the popover opens: the
 * listing is read whenever the chooser can act, not only while it is open, and
 * asked again on every open. Until the user edits the store it follows each
 * new answer; once they have, the pick is theirs and no later listing moves
 * it. Closing drops the edit (`useRoutingStore`). An answer that lands with
 * the popover already open moves the picker's profile dropdown with the store
 * (`useRailFollowsSeed`), so the dropdown, the footer and what Switch sends
 * name one account.
 *
 * ## The machine
 *
 * The catalog, the listing, the providers read and the verbs all go through
 * the TAB's host client, and the picker reads the same host as its run target
 * - so the store's catalog and the picker's own reads agree on the machine.
 * `hostId` (the chat session's host) keys only the session-store reads: the
 * lease and the announcer.
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
  const entryTuple = useStableValue(entrySeedTuple(entry), sameRunSettings);
  const listing = useRoutingListing({
    client,
    epicId,
    chatId,
    entry,
    entryTuple,
    open,
    enabled: canAct,
  });
  const { data, failedTuple, labelFor, modelLabelFor } = listing;
  const seed = useStableValue(
    recommendedTuple(data, failedTuple),
    sameRunSettings,
  );
  const { store, dropEdits, isSeeded } = useRoutingStore(seed);
  const countdown = entry.kind === "countdown" ? entry.pending : null;
  const lease = useRoutingLease({ epicId, chatId, hostId, countdown, open });
  const [refusal, setRefusal] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const openRef = useRef<(() => void) | null>(null);
  const followSelectionRef = useRef<(() => void) | null>(null);
  const noteRailOpen = useRailFollowsSeed({
    store,
    followSelectionRef,
    isSeeded,
  });

  const { onOpened, onClosed, skipNextRelease } = lease;
  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      setRefusal(null);
      noteRailOpen(next);
      if (next) {
        onOpened();
        return;
      }
      onClosed();
      // A pick abandoned by closing is not where the next open starts.
      dropEdits();
    },
    [dropEdits, noteRailOpen, onClosed, onOpened],
  );

  const hostLabel = useHostDirectoryEntry(hostId)?.label ?? null;
  const onAnswer = useCallback(
    (answer: RoutingAnswer) => {
      if (answer.outcome === "applied") {
        // The frame that follows is the feedback, and the traversal has
        // advanced - there is no frozen remainder left to hand back.
        skipNextRelease();
        closeRef.current?.();
        return;
      }
      setRefusal(answerRefusalText(answer, hostLabel));
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
      store,
      data,
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

  const footerRefusal =
    refusal ?? (lease.refused ? COUNTDOWN_NOT_PAUSED_LABEL : null);
  const footer = useMemo(
    () => (
      <RoutingConfirmFooter
        store={store}
        failedTuple={failedTuple}
        data={data}
        labelFor={labelFor}
        modelLabelFor={modelLabelFor}
        refusal={footerRefusal}
        canAct={canAct}
        countdownReady={lease.ready}
        busy={verbs.busy}
        onConfirm={onConfirm}
      />
    ),
    [
      canAct,
      data,
      failedTuple,
      footerRefusal,
      labelFor,
      lease.ready,
      modelLabelFor,
      onConfirm,
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
      followSelectionRef,
      onOpenChange,
      footer,
    }),
    [footer, onOpenChange, trigger],
  );

  return (
    <>
      <RoutingCatalogSync store={store} client={client} open={open} />
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

/* ------------------------------------------------------------------------- */
/* Listing                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The engine's destinations for this entry, and the resolvers that name them.
 *
 * Read whenever the chooser can act, not only while it is open: the store is
 * seeded from its recommendation before the popover opens, so the popover
 * never opens on one place and moves to another under the user. Every open
 * asks again as well - the list is a snapshot of a world that moves, a gauge
 * refreshes or a sibling chat takes the account - and the fresh answer moves
 * the store only while the user has not.
 *
 * A revision bump (the countdown going `hold` -> `choosing`) is a new query
 * key, and a new key has no data: the previous answer stands until the new
 * one lands.
 */
function useRoutingListing(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly entry: RoutingDestinationEntry;
  readonly entryTuple: ChatRunSettings;
  readonly open: boolean;
  readonly enabled: boolean;
}) {
  const { client, epicId, chatId, entry, entryTuple, open, enabled } = input;
  const selector = useStableValue(entrySelector(entry), sameJson);
  const targets = useFallbackListTargets(client, {
    epicId,
    chatId,
    selector,
    enabled,
  });
  const { refetch } = targets;
  useEffect(() => {
    // Query's `refetch` settles a failure into the query rather than
    // rejecting, so there is nothing to catch here.
    if (open && enabled) void refetch();
  }, [enabled, open, refetch]);
  const [held, setHeld] = useState(targets.data);
  if (targets.data !== undefined && targets.data !== held) {
    setHeld(targets.data);
  }
  const data = targets.data ?? held;
  const failedTuple = data?.failedTuple ?? entryTuple;
  const labelFor = useFallbackProfileLabels(client, open);
  // The failed tuple's harness, plus one per equivalent-model row: the
  // destinations a listed target can name.
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
  return { data, failedTuple, labelFor, modelLabelFor };
}

/**
 * The tuple the chooser opens on: the host's recommended account when it is
 * usable, else the failed tuple itself.
 *
 * A sibling account's tuple is built here, as the host documents
 * (`fallbackProfileTargetSchema`): only the account moves, so there is
 * nothing for the engine to re-derive. A `rate-limited` skip is CURRENT
 * evidence the account is dead - not a place to open on, recommended or not;
 * an unrecognised reason degrades to usable rather than to a policy invented
 * from a word this build does not know.
 */
function recommendedTuple(
  data: ChatFallbackListTargetsResponse | undefined,
  failedTuple: ChatRunSettings,
): ChatRunSettings {
  if (data === undefined || data.outcome !== "listed") return failedTuple;
  const pick = data.profileTargets.find(
    (target) =>
      target.recommended &&
      target.selectable &&
      !skipIsCurrentDeadEvidence(target.skip),
  );
  return pick === undefined
    ? failedTuple
    : { ...failedTuple, profileId: pick.profileId };
}

function skipIsCurrentDeadEvidence(skip: FallbackTargetSkip | null): boolean {
  if (skip === null) return false;
  const parsed = tierRungSkipReasonSchema.safeParse(skip.reason);
  return parsed.success && parsed.data === "rate-limited";
}

/* ------------------------------------------------------------------------- */
/* Verbs                                                                     */
/* ------------------------------------------------------------------------- */

/** What Switch sends, by entry. */
type RoutingRequest =
  | {
      readonly kind: "switch-attempt";
      readonly target: ChatRunSettings;
      readonly attempt: LastFailedAttempt;
    }
  | {
      readonly kind: "choose";
      readonly traversalId: string;
      readonly revision: number;
      readonly target: ChatRunSettings;
      readonly leaseToken: string | null;
    };

function routingRequestFor(input: {
  readonly entry: RoutingDestinationEntry;
  readonly store: ComposerToolbarStore;
  readonly data: ChatFallbackListTargetsResponse | undefined;
  readonly failedTuple: ChatRunSettings;
  readonly leaseToken: string | null;
}): RoutingRequest | null {
  const { entry } = input;
  const target = confirmTarget(
    input.store.getState(),
    input.data,
    input.failedTuple,
  );
  if (target === null) return null;
  if (entry.kind === "failed-turn") {
    return { kind: "switch-attempt", target, attempt: entry.attempt };
  }
  return {
    kind: "choose",
    traversalId: entry.pending.traversalId,
    revision: entry.pending.revision,
    target,
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
 * hook-level reporting takes over (the announcer). A transport failure prints
 * the same sentence the listing prints when it cannot reach the host - one
 * unreachable host is one fact.
 */
function useRoutingVerbs(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly open: boolean;
  readonly onAnswer: (answer: RoutingAnswer) => void;
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
              onAnswer({
                verb: "manual",
                outcome: response.outcome,
                detail: response.detail,
                rung: "switch",
              });
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
              onAnswer({ verb: "choose", outcome: response.outcome });
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

/* ------------------------------------------------------------------------- */
/* Store                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The standalone toolbar store, kept on `seed` - the tuple the chooser opens
 * on - until the user edits it.
 *
 * Every edit replaces the store's `values` (a rail, account or row click, an
 * effort change) and nothing else does - a catalog push never touches them -
 * so a store still holding the values it was last seeded with is one the user
 * has not edited, and a new seed moves it, open or closed. Once edited it is
 * the user's: no later listing overwrites a tuple or an effort they chose,
 * even one that walks back to the seed, until `dropEdits` (a close) puts it
 * back. Each seeding goes in under a fresh key - re-applying an unchanged key
 * is a no-op by design.
 */
function useRoutingStore(seed: ChatRunSettings): {
  readonly store: ComposerToolbarStore;
  /** Put the store back on the current seed, following it again. */
  readonly dropEdits: () => void;
  /**
   * Whether `values` are the ones the last seeding wrote - the store has not
   * been edited since, so a move to them was a seed's, not the user's.
   */
  readonly isSeeded: (values: ComposerToolbarValues) => boolean;
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
  const seededRef = useRef({ tuple: seed, values: store.getState().values });
  const applySeed = useCallback(
    (next: ChatRunSettings) => {
      generationRef.current += 1;
      store
        .getState()
        .applySeed(seedKeyFor(next, generationRef.current), seedValues(next));
      seededRef.current = { tuple: next, values: store.getState().values };
    },
    [store],
  );
  useEffect(() => {
    const seeded = seededRef.current;
    if (seeded.tuple === seed) return;
    if (store.getState().values !== seeded.values) return;
    applySeed(seed);
  }, [applySeed, seed, store]);
  const dropEdits = useCallback(() => {
    const seeded = seededRef.current;
    if (seeded.tuple === seed && store.getState().values === seeded.values) {
      return;
    }
    applySeed(seed);
  }, [applySeed, seed, store]);
  const isSeeded = useCallback(
    (values: ComposerToolbarValues) => values === seededRef.current.values,
    [],
  );
  return useMemo(
    () => ({ store, dropEdits, isSeeded }),
    [dropEdits, isSeeded, store],
  );
}

/**
 * Keeps the open picker's browsed account on the store's selection when a
 * SEED moves it, and returns the note of the open state that arms it.
 *
 * The picker takes its rail - the provider and the account its profile
 * dropdown names - from the store's selection when it opens, and afterwards
 * only from its own clicks. That is right for the composer, where nothing else
 * moves the store. Here the store follows the listing until the user edits it
 * ({@link useRoutingStore}), and on a first open the listing can answer AFTER
 * the popover opened: the footer and the payload moved to the recommended
 * account while the dropdown went on naming the one the chooser opened on.
 *
 * `followSelectionRef` moves the picker's rail to the store's selection and
 * nothing else. A search the user typed, the row they reached with the arrow
 * keys and the list's scroll all stay, and no open is reported, so nothing
 * that listens for opens - the lease, the refusal line - hears it. A move to
 * another provider re-anchors the list by the picker's own rule, exactly as a
 * click on that provider would.
 *
 * Only a seed's move. An edit is the user's: a pick in the picker moved its
 * rail already, and an edit elsewhere - the effort footer - must not pull the
 * rail off a provider the user is browsing. The rail's values are noted when
 * the picker reports the open, which runs before any seed applied in the same
 * commit, so a listing that answers right after the click is still a move away
 * from them.
 *
 * A LAYOUT effect, so no frame is painted between the store's move and the
 * rail's: the handle reads the selection from the store when called, and the
 * rail move it dispatches renders before the browser paints. That move is the
 * picker's own state, never the store's values, so it cannot run this effect
 * again.
 */
function useRailFollowsSeed(input: {
  readonly store: ComposerToolbarStore;
  readonly followSelectionRef: RefObject<(() => void) | null>;
  readonly isSeeded: (values: ComposerToolbarValues) => boolean;
}): (open: boolean) => void {
  const { store, followSelectionRef, isSeeded } = input;
  const railRef = useRef<ComposerToolbarValues | null>(null);
  const values = useStore(store, (state) => state.values);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (rail === null || rail === values) return;
    railRef.current = values;
    if (isSeeded(values)) followSelectionRef.current?.();
  }, [followSelectionRef, isSeeded, values]);
  return useCallback(
    (open: boolean) => {
      railRef.current = open ? store.getState().values : null;
    },
    [store],
  );
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
  // Whether this chooser still owes the host its hold back: set by an open
  // that asks for one, cleared by the ONE release that pays it - a close, the
  // unmount, or an applied pick (which leaves nothing to hand back). Every
  // path goes through it, so no two can release one hold: an unmount while
  // open reaches both this hook's own unmount cleanup and, through the
  // picker's unmount close report, `onClosed`.
  const owesReleaseRef = useRef(false);
  useReaskHoldOnRetire({ open, lease, pending: countdown, hold });
  // A plain `release()`: the session store owns the rest, because chooser
  // visibility and lease lifetime are different facts - a close that beats
  // the ack leaves the store owing the release, paid when the token lands.
  const payRelease = useCallback(() => {
    if (!owesReleaseRef.current) return;
    owesReleaseRef.current = false;
    release();
  }, [release]);
  useReleaseOnUnmount(payRelease);
  const onOpened = useCallback(() => {
    if (traversalId === null) return;
    owesReleaseRef.current = true;
    hold(traversalId);
  }, [hold, traversalId]);
  const skipNextRelease = useCallback(() => {
    owesReleaseRef.current = false;
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
    onClosed: payRelease,
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
 * Hands the hold back when the chooser unmounts open. A released chat session
 * stays warm for ten minutes, so closing the tile over an open chooser would
 * otherwise leave the host holding a window with no UI anywhere to give it
 * back. Kept even though the picker now reports that close too: this is the
 * wrapper's own guarantee, not a dependency on how its child unmounts.
 *
 * `payRelease` releases only a hold still owed, so this and the picker's own
 * unmount close report cannot both pay it. A latest-value ref, so the cleanup
 * runs on unmount and on nothing else.
 */
function useReleaseOnUnmount(payRelease: () => void): void {
  const payReleaseRef = useRef(payRelease);
  useEffect(() => {
    payReleaseRef.current = payRelease;
  });
  useEffect(
    () => () => {
      payReleaseRef.current();
    },
    [],
  );
}

/* ------------------------------------------------------------------------- */
/* Confirm                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * What of the store the confirm reads: the pick, its derived effort, and the
 * catalog model it resolved to (for a null-effort target's default and the
 * fast-mode check). `ComposerToolbarState` is one.
 */
interface RoutingPick {
  readonly selection: HarnessModelSelection;
  readonly reasoning: ReasoningLevel;
  readonly selectedModel: ModelOption | null;
}

/**
 * What Switch sends for the store's current pick.
 *
 * A pick that IS one of the listing's equivalent-model destinations - see
 * {@link listedTarget} - sends that destination's HOST-BUILT target
 * unchanged: crossing providers re-derives effort and fast mode against the
 * destination's catalog, and a client copy would drift from it. Anything else
 * is a client tuple: the store's (harness, model, account, effort) over the
 * failed tuple, whose permission and agent mode it keeps - never the chat
 * composer's - and its fast mode only where the picked model offers it. A
 * sibling account needs no host copy: only the account moves.
 *
 * Pure over a {@link RoutingPick} rather than the store, so the footer reads
 * back the tuple Switch would send - its line names it. `null` while the
 * store's model is still resolving: a `""` model never reaches the wire.
 */
function confirmTarget(
  pick: RoutingPick,
  data: ChatFallbackListTargetsResponse | undefined,
  failedTuple: ChatRunSettings,
): ChatRunSettings | null {
  const { selection, reasoning } = pick;
  if (selection.modelSlug.length === 0) return null;
  const listed = listedTarget(pick, data);
  if (listed !== null) return listed;
  const effort = reasoning.length === 0 ? null : reasoning;
  const tier = normalizeServiceTierForModel(
    failedTuple.serviceTier ?? "",
    pick.selectedModel,
  ).trim();
  return {
    ...failedTuple,
    harnessId: selection.harnessId,
    model: selection.modelSlug,
    profileId: selection.profileId,
    reasoningEffort: effort,
    serviceTier: tier.length === 0 ? null : tier,
  };
}

/**
 * The listing's host-built target the pick IS, if any: the same (harness,
 * model, account) at the same EFFECTIVE effort. Effective on both sides, never
 * the raw representation - the store's side is its derived effort, and the
 * target's is its own or, where it names none ("the model's default"), what
 * this store derives `""` to on that model. So a pick that resolves to a
 * target's explicit effort matches it, and an effort moved anywhere else
 * does not.
 */
function listedTarget(
  pick: RoutingPick,
  data: ChatFallbackListTargetsResponse | undefined,
): ChatRunSettings | null {
  if (data === undefined) return null;
  const { selection } = pick;
  for (const row of data.modelTargets) {
    const target = row.target;
    if (
      target === null ||
      target.harnessId !== selection.harnessId ||
      target.model !== selection.modelSlug ||
      target.profileId !== selection.profileId
    ) {
      continue;
    }
    const effort =
      target.reasoningEffort ??
      normalizeReasoningForModel(
        "",
        pick.selectedModel,
        ROUTING_REASONING_FALLBACK,
      );
    if (effort === pick.reasoning) return target;
  }
  return null;
}

/**
 * The chooser's footer: one line and one Switch.
 *
 * The line says where Switch replays the message - the picked model and
 * account, "Replays on Sonnet 5 · Surya in a new session" - or, once the host
 * refused, why it did not. It reads back the tuple Switch would send, through
 * the same `confirmTarget`, so it moves with every pick and can never name a
 * place the button does not go.
 *
 * Switch waits for a pick that goes somewhere (the failed tuple itself is not
 * a switch), a model the store has resolved, and - on the countdown - the
 * host's hold, so a pick cannot land while the countdown is still being spent.
 */
function RoutingConfirmFooter({
  store,
  failedTuple,
  data,
  labelFor,
  modelLabelFor,
  refusal,
  canAct,
  countdownReady,
  busy,
  onConfirm,
}: {
  readonly store: ComposerToolbarStore;
  readonly failedTuple: ChatRunSettings;
  readonly data: ChatFallbackListTargetsResponse | undefined;
  readonly labelFor: FallbackProfileLabelResolver;
  readonly modelLabelFor: FallbackModelLabelResolver;
  readonly refusal: string | null;
  readonly canAct: boolean;
  readonly countdownReady: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}) {
  const selection = useStore(store, (state) => state.selection);
  const reasoning = useStore(store, (state) => state.reasoning);
  const selectedModel = useStore(store, (state) => state.selectedModel);
  // The RAW effort, not the derived one: the store clamps an effort the model
  // does not advertise, and a clamp is not the user choosing a new one.
  const rawReasoning = useStore(store, (state) => state.values.reasoning);
  const moved =
    !selectionIsTuple(selection, failedTuple) ||
    rawReasoning !== (failedTuple.reasoningEffort ?? "");
  const target = confirmTarget(
    { selection, reasoning, selectedModel },
    data,
    failedTuple,
  );
  const line =
    refusal ??
    (target === null
      ? null
      : switchLine({ target, selectedModel, labelFor, modelLabelFor }));
  const disabled =
    busy || !canAct || !moved || !countdownReady || target === null;
  return (
    <div className="flex items-center gap-2 border-t px-2 py-1.5">
      {/*
       * The refusal's live region: persistent and empty until there is
       * something to say, because a region mounted with its text announces
       * nothing. The visible line repeats it for sight only.
       */}
      <div role="status" aria-live="polite" className="sr-only">
        {refusal}
      </div>
      <div
        aria-hidden={refusal !== null}
        className={cn(
          "min-w-0 flex-1 text-ui-xs",
          refusal === null
            ? "truncate text-muted-foreground"
            : "text-warning-foreground",
        )}
      >
        {line}
      </div>
      <Button size="sm" disabled={disabled} onClick={onConfirm}>
        Switch
        {busy ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}

/**
 * The footer line for a target. The model is named as the list above names
 * it - the catalog entry the store resolved - and by the fallback resolver
 * only while that has not loaded.
 */
function switchLine(input: {
  readonly target: ChatRunSettings;
  readonly selectedModel: ModelOption | null;
  readonly labelFor: FallbackProfileLabelResolver;
  readonly modelLabelFor: FallbackModelLabelResolver;
}): string {
  const { target, selectedModel, labelFor } = input;
  const modelLabel =
    selectedModel !== null && selectedModel.slug === target.model
      ? modelDisplayLabel(selectedModel)
      : fallbackDestinationOfTuple(target, labelFor, input.modelLabelFor)
          .modelLabel;
  return routingSwitchLine(modelLabel, labelFor(target.profileId));
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
