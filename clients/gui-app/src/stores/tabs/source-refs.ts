import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  isOpenLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { botTabRecords, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The canonical set of refs a strip layout may reference: every open Epic tab
 * in canvas order, then every open, non-retired landing draft, then every
 * open bot tab (oldest first). Closed drafts stay in the store for history
 * but are not strip sources. Retirement can precede another window's
 * storage-event cleanup of its local row.
 *
 * Defined once on purpose. Reconciliation (the command coordinator) and
 * hydration/sanitize (desktop persistence) have to agree on exactly what counts
 * as a source ref; when each kept its own copy, a new source kind or a changed
 * filter could reach one side only and silently desync placement from
 * hydration.
 */
export function tabSourceRefs(): ReadonlyArray<TabRef> {
  const canvas = useEpicCanvasStore.getState();
  const epics = canvas.openTabOrder.flatMap<TabRef>((id) =>
    canvas.tabsById[id] === undefined ? [] : [{ kind: "epic", id }],
  );
  const drafts = useLandingDraftStore
    .getState()
    .drafts.filter(isOpenLandingDraft)
    .map<TabRef>((draft) => ({ kind: "draft", id: draft.id }));
  const bots = botTabRecords(useBotTabsStore.getState().tabs).map<TabRef>(
    (record) => ({ kind: "bot", id: record.botId }),
  );
  return [...epics, ...drafts, ...bots];
}

/**
 * Whether `kind` is one of the SOURCE-BACKED kinds: a ref the layout may hold
 * only while its source store holds a record. The two system kinds live in the
 * tabs store itself, and `home` has no record at all. Every place that walks a
 * layout asking "is this ref still backed" reads this rather than spelling the
 * kinds out, so a new source kind reaches all of them at once.
 */
export function isSourceBackedTabKind(kind: TabRef["kind"]): boolean {
  return kind === "epic" || kind === "draft" || kind === "bot";
}
