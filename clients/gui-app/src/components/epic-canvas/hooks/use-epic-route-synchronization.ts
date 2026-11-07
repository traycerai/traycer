import { pruneRecoveryTiles } from "@/lib/tab-recovery/history";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useNavigate,
  useRouter,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { v4 as uuidv4 } from "uuid";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  useActiveEpicArtifactId,
  useEpicCanvas,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { isTileRefRecordLive } from "@/stores/epics/canvas/canvas-selectors";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import {
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import {
  cloudChatListAuthorizesRecordSweep,
  useCloudChatHasCloudAuthorization,
  useCloudChatList,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useEnvironmentArmChats } from "@/hooks/environment/use-environment-arms";
import { armRowNamesHeldChat } from "@/lib/chats/compose-task-chat-list";
import { cloudRowIsViewersOwn } from "@/lib/chats/unified-chat-list";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  epicNodeRecency,
  useEpicArtifactRecords,
  useEpicChatRecordListAuthoritative,
  useEpicTuiAgentRecordListAuthoritative,
  useEpicLastFocusedArtifactId,
  useEpicSnapshotLoaded,
} from "@/lib/epic-selectors";
import { resolveAutoOpenTarget } from "@/lib/epic-auto-open";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { requestCommentThreadAnchorReveal } from "@/lib/comments/comment-editor-registry";
import { getHistoryController } from "@/lib/persistent-history";
import { applyRouteBookkeeping } from "@/lib/tab-navigation/route-bookkeeping";
import {
  areNestedFocusTargetsEqual,
  buildNestedFocusSearchPatch,
  getCurrentNestedFocusTarget,
  parseNestedFocusTargetFromSearch,
  resolveNestedFocusTarget,
  type NestedFocusTarget,
} from "@/lib/epic-nested-focus-route";
import { consumeNestedRoutePrimaryEditorFocus } from "@/lib/nested-route-dom-focus";
import {
  beginNestedFocusNavigation,
  forgetExplicitNestedFocusIntents,
  getNestedRouteApplicationDeferralMs,
  lastExplicitNestedFocusIntentSeq,
  lastReturnedToNestedFocusRequestSeq,
  subscribeExplicitNestedFocusIntents,
} from "@/lib/nested-focus-navigation-intent";
import { shouldYieldPaneActivationRouteFocus } from "@/components/epic-canvas/pane-activation";
import { findHostedTileElement } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { isCurrentEpicTabRoute } from "@/lib/epic-nested-focus-navigation";

const PRIMARY_CHAT_COMPOSER_SELECTOR =
  "[data-chat-composer] [data-composer-editor]";
const ARTIFACT_EDITOR_SELECTOR = "[data-artifact-editor]";

type NavigateFn = UseNavigateResult<string>;

export interface EpicRouteFocusIntent {
  readonly epicId: string;
  readonly tabId: string;
  readonly focusedAt: number | undefined;
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly focusPaneId: string | undefined;
  readonly focusTileInstanceId: string | undefined;
}

/**
 * Keeps the route's focus intent, the live per-epic session store, and the
 * GUI-owned canvas/tab store synchronized after mount. These writes target
 * external stores backed by a live stream/Y.Doc, so they intentionally stay
 * in effects rather than being derived during render.
 */
export function useEpicRouteSynchronization(
  intent: EpicRouteFocusIntent,
): void {
  const {
    epicId,
    tabId,
    focusedAt,
    focusArtifactId,
    focusThreadId,
    focusPaneId,
    focusTileInstanceId,
  } = intent;
  const router = useRouter();
  const navigate = useNavigate();
  const handle = useOpenEpicHandle();
  const snapshotLoaded = useEpicSnapshotLoaded();
  const persistedFocus = useEpicLastFocusedArtifactId();
  const records = useEpicArtifactRecords();
  // Same-host counterpart of the cross-host cloud fallback:
  // `epic.listCloudChats` already excludes anything this host's
  // own registry has tombstoned, so "still cloud-known" is what tells a
  // never-adopted chat apart from a genuinely deleted one for
  // `isTileRefRecordLive` below. `useCloudChatList`'s TanStack Query cache is
  // shared with the sidebar's own call for this same epic - no extra
  // network traffic from reading it a second time here - which holds only
  // because both resolve the SAME client: the Epic session's.
  const sessionHostClient = useEpicSessionHostClient();
  const cloudChats = useCloudChatList({
    client: sessionHostClient,
    taskId: epicId,
    enabled: epicId.length > 0,
  });
  // The same verdict the list above was gated on, read once and handed to the
  // sweep guard below. `useCloudChatList` disables itself without it, and a
  // DISABLED list is the guard's strongest authorizing arm - so this is not a
  // second opinion about authorization, it is the one answer travelling to both
  // halves of a read/destroy pair that must not disagree.
  const cloudChatsCloudAuthorized = useCloudChatHasCloudAuthorization();
  // The arm rows alone, from the lanes `useCloudChatList` above already holds
  // for this task, so this read opens no stream of its own.
  const armChats = useEnvironmentArmChats(epicId);
  // A chat a member creates on a team host is environment-owned, so its row
  // reaches this client only as the arm's published cloud row - never as a
  // record that would retire the stand-in filed under the creator. The arm
  // row names the same chat by `(chatId, ownerHostId)`, so a PUBLISHED one
  // retires it, and the click opens the environment's chat. The arm also
  // serves metadata-only rows, with no head: before first publication there
  // is no published row, so the stand-in stays and the click stays live.
  //
  // Re-checked when the store's chats move as well as when the arm does: a
  // create's answer can land after the arm row.
  useEffect(() => {
    if (armChats.length === 0) return;
    const retire = (chats: OpenEpicState["chats"]): void => {
      for (const row of armChats) {
        if (row.headSha256 === null) continue;
        const { chatId } = row.identity;
        if (!Object.hasOwn(chats.byId, chatId)) continue;
        if (!armRowNamesHeldChat(row, chats.byId[chatId])) continue;
        handle.store.getState().expirePendingChatCreationForCloudRow({
          chatId,
          ownerHostId: row.ownerHostId,
        });
      }
    };
    retire(handle.store.getState().chats);
    return handle.store.subscribe((state, previous) => {
      if (state.chats !== previous.chats) retire(state.chats);
    });
  }, [armChats, handle]);
  const applyNestedRouteFocus = useEpicCanvasStore(
    (s) => s.applyNestedRouteFocus,
  );
  const closeCanvasTab = useEpicCanvasStore((s) => s.closeCanvasTab);
  const [nestedRouteRetryToken, setNestedRouteRetryToken] = useState(0);
  const pendingCreateArtifactIds = useEpicCanvasStore(
    (s) => s.pendingCreateArtifactIds,
  );
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const canvas = useEpicCanvas(tabId);
  const hasRestoredCanvas = canvas.root !== null;
  const nestedRouteTarget = useMemo(
    () =>
      parseNestedFocusTargetFromSearch({
        focusPaneId,
        focusTileInstanceId,
      }),
    [focusPaneId, focusTileInstanceId],
  );
  const nestedFocusEnabled = getHistoryController(router.history) !== null;
  const currentNestedTarget = useMemo(
    () => (hasRestoredCanvas ? getCurrentNestedFocusTarget(canvas) : null),
    [hasRestoredCanvas, canvas],
  );
  const resolvedNestedRouteTarget = useMemo(
    () =>
      nestedFocusEnabled && hasRestoredCanvas && nestedRouteTarget !== null
        ? resolveNestedFocusTarget(canvas, nestedRouteTarget)
        : null,
    [nestedFocusEnabled, hasRestoredCanvas, nestedRouteTarget, canvas],
  );
  const nestedRouteTargetApplied = isNestedRouteTargetApplied(
    resolvedNestedRouteTarget,
    currentNestedTarget,
  );
  const legacyFocusHonorableAfterArtifactActivation =
    !nestedFocusEnabled ||
    nestedRouteTarget === null ||
    (focusArtifactId !== undefined &&
      nestedRouteTargetApplied &&
      activeArtifactId === focusArtifactId);

  // A pending artifact-focus request and whether the person has since retired
  // it. See `markExplicitNestedFocusIntent` for why the signal is a stamp taken
  // at the navigation boundary rather than anything read off the canvas.
  const focusRequestKey =
    focusArtifactId === undefined
      ? null
      : `${epicId}|${focusArtifactId}|${focusedAt ?? ""}`;
  // Subscribed rather than read imperatively, because one gesture this has to
  // catch moves nothing else: re-selecting the already-focused tile leaves the
  // canvas byte-identical, so a consumer watching canvas state would never
  // re-render to notice it.
  const lastIntentSeq = useSyncExternalStore(
    subscribeExplicitNestedFocusIntents,
    useCallback(
      () => lastExplicitNestedFocusIntentSeq(epicId, tabId),
      [epicId, tabId],
    ),
  );
  // The other half of the same question, read the same way. Two numbers rather
  // than one object because a snapshot has to be referentially stable between
  // renders; stamped from one sequence so the higher of the two is simply what
  // happened last.
  const lastReturnSeq = useSyncExternalStore(
    subscribeExplicitNestedFocusIntents,
    useCallback(
      () => lastReturnedToNestedFocusRequestSeq(epicId, tabId),
      [epicId, tabId],
    ),
  );
  // Sampled the first time this key is RENDERED - before any effect, so before
  // the `snapshotLoaded` gate below: the task can still be loading when the
  // person acts, and a baseline taken once the snapshot had landed would read
  // their action as having happened before the request and never retire it.
  // React's documented "adjust state when a prop changes" shape, not an effect.
  const [focusRequestBaseline, setFocusRequestBaseline] =
    useState<FocusRequestBaseline | null>(null);
  if ((focusRequestBaseline?.key ?? null) !== focusRequestKey) {
    // A later click on the same artifact carries a fresh `focusedAt`, so it is
    // a different key and therefore a new request, owed its own wait.
    setFocusRequestBaseline(
      focusRequestKey === null
        ? null
        : {
            key: focusRequestKey,
            lastIntentSeq,
            lastReturnSeq,
            nestedTargetPresent: nestedRouteTarget !== null,
          },
    );
  }
  const {
    retired: focusRequestRetired,
    restored: focusRequestRestored,
    outranksNestedRoute: focusRequestOutrunsNestedRoute,
  } = readFocusRequestState(focusRequestBaseline, focusRequestKey, {
    lastIntentSeq,
    lastReturnSeq,
  });

  // Dropped when this surface goes, so the per-tab stamps stay bounded by the
  // tabs actually mounted. Unconditional, and safe to run while this surface
  // still holds a baseline taken from the dropped stamp - see
  // `forgetExplicitNestedFocusIntents`.
  useEffect(() => {
    return () => forgetExplicitNestedFocusIntents(epicId, tabId);
  }, [epicId, tabId]);

  useEffect(() => {
    if (!snapshotLoaded) {
      return;
    }
    if (!nestedFocusEnabled) {
      return;
    }
    if (!hasRestoredCanvas) {
      return;
    }
    const deferralMs = getNestedRouteApplicationDeferralMs(
      epicId,
      tabId,
      nestedRouteTarget,
    );
    if (deferralMs !== null) {
      const timeout = window.setTimeout(() => {
        setNestedRouteRetryToken((token) => token + 1);
      }, deferralMs);
      return () => window.clearTimeout(timeout);
    }

    if (nestedRouteTarget === null) {
      if (
        shouldDeferToLegacyArtifactFocus({
          focusArtifactId,
          focusThreadId,
          activeArtifactId,
          requestRetired: focusRequestRetired,
        })
      ) {
        return;
      }
      const target = getCurrentNestedFocusTarget(canvas);
      if (target === null) {
        return;
      }
      replaceNestedFocusRoute(navigate, { epicId, tabId }, target);
      return;
    }

    const resolved = resolveNestedFocusTarget(canvas, nestedRouteTarget);
    if (resolved === null) {
      const fallback = getCurrentNestedFocusTarget(canvas);
      replaceNestedFocusRoute(navigate, { epicId, tabId }, fallback);
      return;
    }

    if (!isNestedRouteTargetApplied(resolved, currentNestedTarget)) {
      applyNestedRouteFocus(tabId, resolved);
      return;
    }
  }, [
    snapshotLoaded,
    nestedFocusEnabled,
    hasRestoredCanvas,
    nestedRouteTarget,
    focusArtifactId,
    focusThreadId,
    activeArtifactId,
    focusRequestRetired,
    canvas,
    navigate,
    epicId,
    tabId,
    currentNestedTarget,
    applyNestedRouteFocus,
    nestedRouteRetryToken,
  ]);

  // The nested-route target we last moved DOM focus to. This effect re-runs on
  // every canvas mutation - a title rename gives `useEpicCanvas` a new identity
  // while the applied target stays byte-for-byte the same - and the restore is
  // only meant to service genuine pane/tab navigation. Gating on an actual
  // target change keeps a bare rename from re-focusing the tile, which would
  // eject a user typing in the body or paint a stray selection ring after a
  // tab-strip rename.
  const lastRestoredNestedTargetRef = useRef<NestedFocusTarget | null>(null);
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (!nestedFocusEnabled) return;
    if (!hasRestoredCanvas) return;
    if (nestedRouteTarget === null) return;
    if (resolvedNestedRouteTarget === null) {
      return;
    }
    if (!nestedRouteTargetApplied) {
      return;
    }
    if (
      areNestedFocusTargetsEqual(
        lastRestoredNestedTargetRef.current,
        resolvedNestedRouteTarget,
      )
    ) {
      return;
    }
    const targetToFocus = resolvedNestedRouteTarget;
    const frame = window.requestAnimationFrame(() => {
      lastRestoredNestedTargetRef.current = targetToFocus;
      focusNestedRouteTarget(
        targetToFocus,
        consumeNestedRoutePrimaryEditorFocus(epicId, tabId, targetToFocus),
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    snapshotLoaded,
    nestedFocusEnabled,
    hasRestoredCanvas,
    nestedRouteTarget,
    resolvedNestedRouteTarget,
    nestedRouteTargetApplied,
    currentNestedTarget,
    epicId,
    tabId,
  ]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    if (
      focusArtifactId !== undefined &&
      !legacyFocusHonorableAfterArtifactActivation
    ) {
      return;
    }
    const target = focusArtifactId ?? persistedFocus;
    if (target === null) return;
    handle.store.getState().setLastFocusedArtifactId(target);
  }, [
    snapshotLoaded,
    focusArtifactId,
    focusedAt,
    persistedFocus,
    legacyFocusHonorableAfterArtifactActivation,
    handle,
    epicId,
    tabId,
    activeArtifactId,
    nestedRouteTarget,
  ]);

  useEffect(() => {
    if (!snapshotLoaded) return;
    if (focusThreadId === undefined) return;
    if (!legacyFocusHonorableAfterArtifactActivation) {
      return;
    }
    handle.store.getState().setLastFocusedThreadId(focusThreadId);
  }, [
    snapshotLoaded,
    focusThreadId,
    focusedAt,
    legacyFocusHonorableAfterArtifactActivation,
    handle,
    epicId,
    tabId,
    focusArtifactId,
    activeArtifactId,
    nestedRouteTarget,
  ]);

  // When the route handed us a `focusThreadId`, show its comments surface
  // and activate the matching thread *after* the auto-open
  // effect has set the artifact active. Gating on `activeArtifactId ===
  // focusArtifactId` avoids racing active-artifact fallback behavior, which
  // reverts the panel when the active artifact stops supporting comments.
  // Each (focusedAt, threadId) combination fires once via the de-dupe ref so
  // manual user interactions (closing the comments panel) aren't fought by
  // stale route state.
  const lastDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (focusThreadId === undefined) return;
    if (focusArtifactId === undefined) return;
    if (!legacyFocusHonorableAfterArtifactActivation) return;
    if (activeArtifactId !== focusArtifactId) return;
    const key = `${epicId}|${focusedAt ?? ""}|${focusThreadId}`;
    if (lastDeepLinkRef.current === key) return;
    lastDeepLinkRef.current = key;
    const type = records.find((record) => record.id === focusArtifactId)?.type;
    if (type !== "html" && type !== "canvas") {
      useLeftPanelStore.getState().revealCommentsPanel(tabId);
      useLeftPanelStore.getState().setActivePanelIdAndExpand(tabId, "comments");
    }
    useCommentThreadsStore.getState().setActiveThread(epicId, focusThreadId);
    if (type === "html" || type === "canvas") {
      useCommentThreadsStore.getState().setFlashThread(epicId, focusThreadId);
      requestCommentThreadAnchorReveal(epicId, focusArtifactId, focusThreadId);
    }
  }, [
    snapshotLoaded,
    focusThreadId,
    focusArtifactId,
    focusedAt,
    activeArtifactId,
    legacyFocusHonorableAfterArtifactActivation,
    epicId,
    tabId,
    records,
  ]);

  const lastAutoOpenKey = useRef<string | null>(null);
  /** The most recent return this effect has already released a key for. */
  const honouredReturnSeq = useRef(0);
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (
      shouldSuppressLegacyAutoOpen({
        nestedFocusEnabled,
        nestedRouteTarget,
        focusArtifactId,
        recordCount: records.length,
        requestOutrunsNestedRoute: focusRequestOutrunsNestedRoute,
      })
    ) {
      return;
    }

    const key = `${epicId}|${focusArtifactId ?? ""}|${focusedAt ?? ""}`;
    const hasExplicitFocus = focusArtifactId !== undefined;
    // A retirement SPENT this key (below), which is what stops a late record
    // reviving a request the person left. Coming back to the request's own
    // entry is them asking for it again, so the spend is released - once per
    // return, tracked by the stamp itself, because `restored` stays true for as
    // long as that return is the latest signal and clearing on every run would
    // reopen the artifact endlessly.
    if (focusRequestRestored && lastReturnSeq > honouredReturnSeq.current) {
      honouredReturnSeq.current = lastReturnSeq;
      if (lastAutoOpenKey.current === key) lastAutoOpenKey.current = null;
    }
    const gate = gateLegacyAutoOpen({
      hasExplicitFocus,
      hasRestoredCanvas,
      keyAlreadySpent: lastAutoOpenKey.current === key,
      anyKeySpent: lastAutoOpenKey.current !== null,
    });
    if (gate === "skip") return;
    if (gate === "spend-key") {
      lastAutoOpenKey.current = key;
      return;
    }

    // Auto-open's recency input, read HERE rather than subscribed to. Every
    // value in it moves on each streamed token, and this decision fires once
    // per key - a subscription would re-render this hook at the token rate to
    // feed a branch that has already run. The projection it reads is the same
    // one `records` comes from, so the two are always in step: whatever agent
    // rows this device has, it has their activity clocks, and an epic whose
    // projection carries no agent rows yields an empty map - the resolver's
    // "no recency available" input, which lands on the first node in tree
    // order exactly as before.
    const target = resolveAutoOpenTarget(
      records,
      focusArtifactId ?? null,
      persistedFocus,
      epicNodeRecency(handle.store.getState()),
    );
    // The person acted while this request was waiting, so it is theirs to lose
    // rather than ours to honour over whatever they moved to. Spend the key so
    // a later arrival of the same record cannot revive it.
    if (hasExplicitFocus && focusRequestRetired) {
      lastAutoOpenKey.current = key;
      return;
    }
    if (target === null) {
      // An explicit REQUEST that cannot resolve yet stays PENDING rather than
      // spending its key: the artifact's record simply has not projected into
      // this device's session yet - a cold cross-task landing, or a record
      // created on another device moments before the click - and it arrives on
      // this effect's own `records` dependency, so the next run resolves it.
      // Burning the key here is what used to drop the request for good, since
      // every later run then returned at `lastAutoOpenKey.current === key` and
      // the requested artifact never opened at all.
      //
      // Nothing is retried on a schedule: there is no timer and no poll, only
      // the re-evaluation this effect already did. A request naming a record
      // that never arrives therefore keeps today's bounded refusal - it opens
      // nothing, quietly. It also names a real artifact: the cross-epic branch
      // of `openResolvedArtifact` only navigates once
      // `epic.resolveArtifactByPath` has confirmed one.
      //
      // A LANDING still spends its key on a null resolve, so its once-per-epic
      // behaviour is unchanged.
      if (!hasExplicitFocus) {
        lastAutoOpenKey.current = key;
      }
      return;
    }
    lastAutoOpenKey.current = key;
    if (activeArtifactId === target.id) {
      return;
    }
    // Route landing uses the same gesture mapping as a link click, but
    // it is the LANDING itself: the focus params it derives belong on the
    // entry the user already navigated to, so the commit REPLACES rather than
    // pushing a second entry they would have to press Back through twice.
    openTileWithNavigation(
      tileIntent(
        {
          id: target.id,
          instanceId: uuidv4(),
          type: target.type,
          name: target.name,
          hostId: target.hostId,
        },
        { tabId },
        "single",
        "deep_link",
      ),
      (targetEpicId, targetTabId, prepare) => {
        const focusTarget = prepare();
        if (focusTarget === null) return null;
        if (
          !isCurrentEpicTabRoute(
            router.state.location.pathname,
            targetEpicId,
            targetTabId,
          )
        ) {
          return focusTarget;
        }
        // Armed for the same reason the navigation boundary arms it: the
        // replace below is async, so until it commits the route still names
        // the PREVIOUS target, and the nested-route sync effect would reapply
        // it and bounce focus straight off the artifact just opened.
        //
        // Unnecessary until now, which is why this path never armed it: the
        // auto-open only ever ran when the route named no nested target, so
        // there was nothing stale to reapply. Letting a waiting request outrank
        // a target committed during its wait is exactly what makes a stale
        // target reachable here, so the guard stops being redundant.
        //
        // It matters most where the commit does not land at all:
        // `replaceNestedFocusRoute` tolerates a rejected or superseded
        // navigation by design, and without this the artifact would open and
        // then sit unfocused behind the tile the route still named.
        beginNestedFocusNavigation(targetEpicId, targetTabId, focusTarget);
        replaceNestedFocusRoute(
          navigate,
          { epicId: targetEpicId, tabId: targetTabId },
          focusTarget,
        );
        return focusTarget;
      },
      // NOT the person: this is the route serving its own focus request, and
      // the request is the thing a human claim would retire. The navigator
      // above takes no provenance at all - it writes the route directly
      // rather than through the boundary that marks - so this is the value
      // that stays correct if it is ever routed through the boundary.
      { ...MANUAL_TILE_OPEN, provenance: "automatic" },
    );
  }, [
    snapshotLoaded,
    records,
    handle,
    focusArtifactId,
    focusedAt,
    persistedFocus,
    hasRestoredCanvas,
    navigate,
    router,
    activeArtifactId,
    epicId,
    tabId,
    nestedFocusEnabled,
    nestedRouteTarget,
    focusRequestRetired,
    focusRequestRestored,
    lastReturnSeq,
    focusRequestOutrunsNestedRoute,
  ]);

  const lastSyncedFocus = useRef<string | null>(persistedFocus);
  useEffect(() => {
    if (!snapshotLoaded) return;
    // `activeArtifactId` is `null` for non-artifact tabs (terminal,
    // workspace-file). Don't sync that `null` into `lastFocusedArtifactId`
    // - it would wipe the epic's last artifact focus, breaking the
    // fallback-restore path when the user returns to an artifact tab.
    if (activeArtifactId === null) return;
    if (activeArtifactId === lastSyncedFocus.current) return;
    lastSyncedFocus.current = activeArtifactId;
    handle.store.getState().setLastFocusedArtifactId(activeArtifactId);
  }, [snapshotLoaded, activeArtifactId, handle]);

  // The host whose projection feeds `records` - the EPIC SESSION's host, not
  // the app-wide active one this used to read. The two differ for the whole
  // of a re-point that is establishing and after one that failed: the
  // provider keeps the previous handle rendered, so `records` are still host
  // A's while the app-wide pointer says B. Policing against B closed the
  // wrong tabs - B-bound tiles judged against A's records read as deleted.
  // Cross-host chat tiles are exempt from record policing (see
  // `isTileRefRecordLive`); everything else is judged against the session
  // host's projection, and the policing identity moves WITH the records - on
  // a committed re-point both flip together, never one before the other.
  const activeHostId = useCanvasHostId();
  const chatRecordListAuthoritative = useEpicChatRecordListAuthoritative();
  const tuiAgentRecordListAuthoritative =
    useEpicTuiAgentRecordListAuthoritative();

  // Close any open tab whose underlying record was removed (sidebar delete,
  // server-side cascade, or remote delete by another collaborator). The
  // sidebar's optimistic Y.Doc delete unmounts the row before the mutation's
  // per-call `onSuccess` can fire (TanStack Query v5 drops observer-attached
  // callbacks on unmount), so the close has to be driven by record→canvas
  // sync rather than by mutation callbacks. `isTileRefRecordLive` is the same
  // predicate back/forward's preview-reopen path uses before restoring a
  // closed tile, so "is this tile's record gone" is answered in one place.
  // An UNANSWERED cloud list is not an empty one, and this decision cannot
  // tell the difference from `data` alone: while the list is in flight (or
  // after it FAILED on a transient transport error) every cloud row reads as
  // absent, which is exactly the never-adopted same-host chat the exemption
  // below exists for - and closing its tab is not undoable by the response
  // that would have saved it.
  //
  // The predicate is the query's own, not flags spelled out here, and it is
  // the sweep-authorizing one rather than plain settledness: a transiently
  // failed list is settled but has produced no evidence about any chat, so it
  // must not authorize closing tabs. `E_HOST_UNSUPPORTED` and a DISABLED
  // query DO authorize - nothing will ever answer through either, and record
  // policing on local records alone is the correct degraded behavior.
  //
  // An UNVERIFIED session does not. Its list is disabled because it may not
  // spend the account's cloud capability, not because there is nothing to
  // learn - the cloud rows are there and this session simply cannot look - so
  // the guard fails closed on the authorization arm and no CHAT tab is closed
  // on that ignorance.
  //
  // Only the chat verdict is withheld, though, not the sweep. Artifacts are
  // doc-shared and a same-host terminal agent is this host's own record, so
  // once its own list has answered, absence from the projection is evidence
  // of deletion whatever the cloud list can or cannot say - and an unverified
  // user deleting a record
  // in a local-homed epic used to leave its tile open and stale until a
  // verdict returned. The sweep therefore runs for an unauthorized session
  // with chat absence marked NON-authoritative: `isTileRefRecordLive` keeps
  // every record-less chat on that flag alone, and the cloud-known set is
  // empty by construction. An authorized session whose list has not answered
  // is a different ignorance and still stops the whole sweep, as before.
  const cloudChatsAuthorizeSweep = cloudChatListAuthorizesRecordSweep(
    cloudChats,
    cloudChatsCloudAuthorized,
  );
  const recordSweepRuns =
    cloudChatsAuthorizeSweep || !cloudChatsCloudAuthorized;
  const chatAbsenceAuthoritative =
    chatRecordListAuthoritative && cloudChatsAuthorizeSweep;
  useEffect(() => {
    if (!snapshotLoaded) return;
    if (!recordSweepRuns) return;
    const liveIds = new Set(records.map((record) => record.id));
    const hasLiveRecord = (id: string) => liveIds.has(id);
    // VIEWER-OWNED rows only, matching `usePublishedChatFallbackRef`'s own
    // filter: `chatId` is host-minted and the list carries collaborators'
    // rows too, so an id-only set could keep a deleted viewer-owned tab open
    // on the strength of a collaborator's row - a row the substitution
    // resolver would then (correctly) refuse to serve, leaving the tab
    // permanently loading instead of closed.
    const cloudKnownIds = new Set(
      (cloudChats.data?.chats ?? [])
        .filter(cloudRowIsViewersOwn)
        .map((chat) => chat.identity.chatId),
    );
    const isCloudKnown = (id: string) => cloudKnownIds.has(id);
    const recordContext = {
      hasLiveRecord,
      isCloudKnown,
      recordListAuthorizesChatAbsence: chatAbsenceAuthoritative,
      recordListAuthorizesTuiAgentAbsence: tuiAgentRecordListAuthoritative,
    };
    const pendingClosedInstances = new Set(
      Object.values(useEpicCanvasStore.getState().closedTilePayloadsByTabId)
        .flatMap((payloads) => Object.entries(payloads ?? {}))
        .flatMap(([instanceId, payload]) =>
          payload?.pendingCreate ? [instanceId] : [],
        ),
    );
    // Apply the same authoritative verdict to older closed instances too.
    // Once the task session is released, missing records are no longer proof
    // of deletion, so recovery must forget them while that proof is available.
    pruneRecoveryTiles(
      (tile, ownerEpicId) =>
        ownerEpicId === epicId &&
        !pendingClosedInstances.has(tile.instanceId) &&
        !isTileRefRecordLive(
          tile,
          pendingCreateArtifactIds,
          recordContext,
          activeHostId,
        ),
    );
    for (const pane of collectPanes(canvas.root)) {
      for (const instanceId of pane.tabInstanceIds) {
        const tab = canvas.tilesByInstanceId[instanceId];
        if (tab === undefined) continue;
        if (
          isTileRefRecordLive(
            tab,
            pendingCreateArtifactIds,
            recordContext,
            activeHostId,
          )
        ) {
          continue;
        }
        closeCanvasTab(tabId, pane.id, tab.instanceId);
      }
    }
  }, [
    snapshotLoaded,
    recordSweepRuns,
    chatAbsenceAuthoritative,
    tuiAgentRecordListAuthoritative,
    canvas,
    records,
    cloudChats.data,
    pendingCreateArtifactIds,
    activeHostId,
    epicId,
    tabId,
    closeCanvasTab,
  ]);
}

/**
 * Marked as route bookkeeping: this replace records view state onto the route
 * its tab is already showing, so the navigation controller must never read a
 * late-landing one as the user navigating back to this epic.
 *
 * Deliberately NOT de-duplicated behind an "at most one in flight" guard.
 * Suppressing a replace while another is in flight leaves the URL naming the
 * EARLIER focus target, and this effect's own branch selection is driven by
 * that URL: once it carries a resolvable target, the route drives the canvas
 * (`applyNestedRouteFocus`) instead of the canvas driving the route, so a
 * suppressed update is not merely delayed - it is inverted, pulling tile
 * focus back to where it had already moved from. Letting every update through
 * keeps the LAST one authoritative, which is the whole contract here.
 */
function replaceNestedFocusRoute(
  navigate: NavigateFn,
  tab: { readonly epicId: string; readonly tabId: string },
  target: NestedFocusTarget | null,
): void {
  navigate(
    applyRouteBookkeeping({
      to: "/epics/$epicId/$tabId",
      params: { epicId: tab.epicId, tabId: tab.tabId },
      search: (prev) => ({
        ...prev,
        focusedAt: prev.focusedAt,
        focusArtifactId: prev.focusArtifactId,
        focusThreadId: prev.focusThreadId,
        migrationSource: prev.migrationSource,
        ...buildNestedFocusSearchPatch(target),
      }),
      replace: true,
    }),
    // Bookkeeping is best-effort by nature: a rejected commit (a blocked or
    // superseded navigation) leaves the URL without this focus target, and the
    // next canvas change re-derives it. Swallow it rather than surfacing an
    // unhandled rejection for something no caller is awaiting.
  ).catch(() => undefined);
}

/**
 * What this run of the legacy auto-open effect may do, before anything is
 * resolved: give up, spend the key without resolving, or go on and resolve.
 *
 * Extracted from the effect because it is the one part of that decision which
 * is pure bookkeeping over the key - a LANDING fires once per epic and an
 * explicit REQUEST once per key - and reading it as four flags here keeps the
 * effect itself about what to open.
 */
type LegacyAutoOpenGate = "skip" | "spend-key" | "resolve";

function gateLegacyAutoOpen(args: {
  readonly hasExplicitFocus: boolean;
  readonly hasRestoredCanvas: boolean;
  readonly keyAlreadySpent: boolean;
  readonly anyKeySpent: boolean;
}): LegacyAutoOpenGate {
  const { hasExplicitFocus, hasRestoredCanvas, keyAlreadySpent, anyKeySpent } =
    args;
  if (hasExplicitFocus) {
    return keyAlreadySpent ? "skip" : "resolve";
  }
  // A restored canvas already shows what the person left open, so a landing
  // records its key and chooses nothing.
  if (hasRestoredCanvas) return "spend-key";
  return anyKeySpent ? "skip" : "resolve";
}

interface FocusRequestBaseline {
  readonly key: string;
  readonly lastIntentSeq: number;
  /** The return stamp when this request arrived. See {@link FocusRequestState.restored}. */
  readonly lastReturnSeq: number;
  /**
   * Whether the route ALREADY named a nested target when this request arrived.
   * See {@link readFocusRequestState}.
   */
  readonly nestedTargetPresent: boolean;
}

interface FocusRequestState {
  /**
   * The person acted after this request arrived, so it is theirs to lose rather
   * than ours to honour over whatever they moved to.
   *
   * Strictly NEWER, never merely different: the baseline outlives the stamp it
   * was taken from, because the sampling surface drops that stamp on every root
   * `StrictMode` replay while React retains the baseline. `>` reads a dropped
   * stamp as what it is - no intent newer than the baseline - where `!==` read
   * it as the person acting and retired a request nobody had touched.
   */
  readonly retired: boolean;
  /**
   * The person navigated BACK to this request's own entry after something had
   * retired it, so it is owed its wait again.
   *
   * Needed because retirement is otherwise permanent for the life of the key,
   * in two reinforcing ways: the baseline it is measured against is never
   * recut, and {@link lastAutoOpenKey} is SPENT on retirement so a late record
   * cannot revive it. Together those mean a person who asks for an artifact,
   * has tiles open automatically over it, and presses Back twice to get back to
   * it would find their own first Back had cancelled it for good.
   *
   * Ordered against {@link retired} rather than replacing it: both stamps come
   * from one sequence, so leaving and returning any number of times resolves to
   * whichever happened last.
   */
  readonly restored: boolean;
  /**
   * Whether this still-waiting request outranks the nested target in the route.
   *
   * A committed nested target normally governs focus outright, and it has to:
   * the route can carry a `focusArtifactId` long after that request was
   * answered, so honouring the artifact again would re-open it on every Back to
   * such a URL.
   *
   * But a target committed WHILE a request was waiting is a different thing
   * from one the request arrived to find. The waiting case is reachable without
   * the person doing anything - a host push surfacing an agent's or a page's
   * browser tab commits a target, and that commit preserves the pending
   * `focusArtifactId` in the URL exactly as it should - and precedence alone
   * then defeated the request: the artifact the person clicked never opened,
   * with nothing in the URL to show why.
   *
   * So only a request that arrived to a route naming NO target outranks one
   * committed later. Back and a cold load are untouched, because in both the
   * target is already there when the key is first seen.
   *
   * {@link retired} still wins over this, which is what keeps a PERSON's nested
   * navigation authoritative: their gesture stamps the tab, the request is
   * retired, and the target they chose governs. Only a commit nobody asked for
   * leaves a request alive to outrank it.
   */
  readonly outranksNestedRoute: boolean;
}

/**
 * Read a pending request's standing from its baseline. A baseline for a
 * different key is a baseline for a different request, and answers neither
 * question.
 */
function readFocusRequestState(
  baseline: FocusRequestBaseline | null,
  key: string | null,
  signals: { readonly lastIntentSeq: number; readonly lastReturnSeq: number },
): FocusRequestState {
  if (baseline === null || baseline.key !== key) {
    return { retired: false, restored: false, outranksNestedRoute: false };
  }
  const { lastIntentSeq, lastReturnSeq } = signals;
  // Newer than the baseline AND newer than the other signal: the first asks
  // whether it happened during this request's wait, the second which of the two
  // happened last.
  const retired =
    lastIntentSeq > baseline.lastIntentSeq && lastIntentSeq > lastReturnSeq;
  const restored =
    lastReturnSeq > baseline.lastReturnSeq && lastReturnSeq > lastIntentSeq;
  return {
    retired,
    restored,
    outranksNestedRoute: !baseline.nestedTargetPresent && !retired,
  };
}

/**
 * Whether the legacy auto-open effect should no-op: a committed nested route
 * target already governs focus, or there is nothing to auto-open yet.
 */
function shouldSuppressLegacyAutoOpen(args: {
  readonly nestedFocusEnabled: boolean;
  readonly nestedRouteTarget: NestedFocusTarget | null;
  readonly focusArtifactId: string | undefined;
  readonly recordCount: number;
  /**
   * Whether a request that is still waiting outranks the committed nested
   * target, because the route named no target when the request arrived. See
   * `focusRequestOutrunsNestedRoute` - without this, a nested target committed
   * during the wait by something nobody asked for defeated the request on
   * precedence alone.
   */
  readonly requestOutrunsNestedRoute: boolean;
}): boolean {
  const {
    nestedFocusEnabled,
    nestedRouteTarget,
    focusArtifactId,
    recordCount,
    requestOutrunsNestedRoute,
  } = args;
  if (
    nestedFocusEnabled &&
    nestedRouteTarget !== null &&
    !requestOutrunsNestedRoute
  ) {
    return true;
  }
  if (recordCount === 0 && focusArtifactId === undefined) {
    return true;
  }
  return false;
}

/**
 * Whether the route-sync effect should defer canonicalizing the current
 * canvas focus into the route because a legacy (`focusArtifactId` /
 * `focusThreadId`) deep link is still pending activation.
 */
function shouldDeferToLegacyArtifactFocus(args: {
  readonly focusArtifactId: string | undefined;
  readonly focusThreadId: string | undefined;
  readonly activeArtifactId: string | null;
  /**
   * Whether the person retired the artifact request by acting themselves. A
   * retired request will never activate its artifact, so deferring to it would
   * never end: the URL keeps naming an id that `activeArtifactId` is now
   * deliberately not, and the route would never record where focus actually
   * went.
   */
  readonly requestRetired: boolean;
}): boolean {
  const { focusArtifactId, focusThreadId, activeArtifactId, requestRetired } =
    args;
  if (focusArtifactId === undefined && focusThreadId === undefined) {
    return false;
  }
  if (focusArtifactId === undefined) {
    return true;
  }
  if (requestRetired) {
    return false;
  }
  if (activeArtifactId !== focusArtifactId) {
    return true;
  }
  return false;
}

function isNestedRouteTargetApplied(
  routeTarget: NestedFocusTarget | null,
  currentTarget: NestedFocusTarget | null,
): boolean {
  if (routeTarget === null) return false;
  if (currentTarget === null) return false;
  if (routeTarget.tileInstanceId === undefined) {
    return currentTarget.paneId === routeTarget.paneId;
  }
  return areNestedFocusTargetsEqual(currentTarget, routeTarget);
}

function focusNestedRouteTarget(
  target: NestedFocusTarget,
  focusPrimaryEditor: boolean,
): void {
  const element =
    target.tileInstanceId === undefined
      ? findActivePaneElement(target.paneId)
      : findSelectedTileElement(target.tileInstanceId);
  if (element === null) {
    return;
  }
  if (!focusPrimaryEditor && shouldYieldPaneActivationRouteFocus(element)) {
    return;
  }
  if (focusPrimaryEditor) {
    const editor =
      element.querySelector<HTMLElement>(PRIMARY_CHAT_COMPOSER_SELECTOR) ??
      element.querySelector<HTMLElement>(ARTIFACT_EDITOR_SELECTOR);
    if (editor !== null) {
      editor.focus({ preventScroll: true });
      return;
    }
  }
  // The pane / tab container is an ancestor of the tile's editing surface, and
  // this effect re-runs on every canvas mutation (a title rename, for one). If
  // focus already lives inside the target, moving it up to the container would
  // blur that deeper element - ejecting a user mid-type from the artifact body.
  // Only pull focus up when it is currently elsewhere, i.e. a genuine
  // pane/tab switch that this restore is meant to service.
  if (element.contains(document.activeElement)) {
    return;
  }
  element.focus({ preventScroll: true });
}

function findActivePaneElement(paneId: string): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>(
    "[data-group-id][data-active='true']",
  );
  return (
    [...elements].find(
      (element) => element.getAttribute("data-group-id") === paneId,
    ) ?? null
  );
}

/**
 * A hosted chat's body no longer sits inside a `[data-tab-instance-id]`
 * pane-tab layer - `TabGroupView` still keeps that selected wrapper mounted
 * around `TileSurfaceSlot`'s bare geometry anchor (it carries layout, tab
 * strip, and DnD target duties independent of hosting), so it is always
 * found by the physical query and would shadow the hosted fallback if tried
 * second. The hosted record, when one
 * exists for this exact `tileInstanceId`, is therefore checked FIRST: its
 * presence unambiguously means the real body lives there, never in the
 * physical wrapper. With the stable-tile-surface-host switch off (or for a
 * non-hosted tile kind) no hosted record ever exists, so this falls straight
 * through to the same physical lookup as before - byte-equivalent.
 */
function findSelectedTileElement(tileInstanceId: string): HTMLElement | null {
  const hosted = findHostedTileElement(document, tileInstanceId);
  if (hosted !== null) return hosted;
  const elements = document.querySelectorAll<HTMLElement>(
    "[data-tab-instance-id][data-selected='true']",
  );
  return (
    [...elements].find(
      (element) =>
        element.getAttribute("data-tab-instance-id") === tileInstanceId,
    ) ?? null
  );
}
