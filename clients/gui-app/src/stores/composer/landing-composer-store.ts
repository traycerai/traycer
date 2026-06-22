import { create } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
// Import the empty-content constant from the dependency-free leaf (NOT from
// `landing-draft-store`) so this module's eval-time read at `EMPTY_CONTENT` below
// can't hit a temporal-dead-zone error in the store import cycle.
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import {
  collectImageAtoms,
  containsImageAtoms,
} from "@/lib/composer/image-atoms";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";

const EMPTY_CONTENT: JsonContent = EMPTY_LANDING_DRAFT_CONTENT;

// Persisting content into the landing draft on EVERY keystroke is the expensive
// part: it mints a new draft object, which re-renders `HomePage` (the whole home
// surface + toolbar), rebuilds the draft's header tab (name = derived text), and
// fires the desktop per-window projection round-trip - per character. None of
// those consumers need per-keystroke freshness (submit reads the live editor,
// not the draft; the tab title and persistence only need eventual consistency),
// so steady-state writes to an EXISTING bound draft are debounced. Writes made
// while the binding is still `null` (the keystrokes that create the draft and
// land before the keyed remount commits) are synchronous - the remount reads the
// content back at mount, so a trailing write would seed it stale.
// `flushPendingLandingDraftContent` commits the pending write immediately and is
// called on composer unmount / rebind so switching away from and back to a draft
// restores the latest content.
const DRAFT_CONTENT_DEBOUNCE_MS = 300;
let pendingDraftContent: {
  id: string;
  content: JsonContent;
  selection: DraftSelection | null;
} | null = null;
let draftContentTimer: Parameters<typeof clearTimeout>[0] | null = null;

function scheduleDraftContentWrite(
  id: string,
  content: JsonContent,
  selection: DraftSelection | null,
): void {
  pendingDraftContent = { id, content, selection };
  if (draftContentTimer !== null) clearTimeout(draftContentTimer);
  draftContentTimer = setTimeout(
    flushPendingLandingDraftContent,
    DRAFT_CONTENT_DEBOUNCE_MS,
  );
}

export function flushPendingLandingDraftContent(): void {
  if (draftContentTimer !== null) {
    clearTimeout(draftContentTimer);
    draftContentTimer = null;
  }
  if (pendingDraftContent === null) return;
  const { id, content, selection } = pendingDraftContent;
  pendingDraftContent = null;
  useLandingDraftStore.getState().setDraftContent(id, content, selection);
}

function cancelPendingLandingDraftContent(): void {
  if (draftContentTimer !== null) {
    clearTimeout(draftContentTimer);
    draftContentTimer = null;
  }
  pendingDraftContent = null;
}

/**
 * Transient UI state for the landing-page composer. The editor itself is the
 * source of truth for content; this store is a pure LIVE MIRROR of the active
 * draft's editor snapshot so the toolbar (canSubmit) and the bound landing draft
 * (content persistence) can react without re-rendering the editor.
 *
 * Draft binding is EXPLICIT: the composer opens its bound draft via
 * `openDraft(draftId)` at mount (the component is keyed by draft id) and passes
 * the same id to every `setSnapshot`. Persistence therefore always targets the
 * draft the snapshot came from - a trailing debounced write can never land on
 * whichever draft happens to be active after a switch. Persisted content lives
 * in `landing-draft-store`; this store keeps only the active draft's snapshot
 * (`currentContent`), so closing/switching drafts reads back from the draft
 * store, not a per-draft cache here.
 *
 * Mutation status (pending / error) is NOT mirrored here - callers read it
 * directly from the TanStack Query mutation results so `isSubmitting` and
 * `canSubmit` stay derived rather than ferried through an extra store field.
 */
interface LandingComposerStore {
  readonly currentContent: JsonContent;
  /**
   * Draft created by `setSnapshot(null, ...)` while this binding session is
   * still `null` (the remount keyed on the new id hasn't committed yet). Routes
   * the session's follow-up snapshots to that same draft so same-tick edits
   * can't mint a second draft.
   */
  readonly createdDraftId: string | null;
  /**
   * Bind the composer to `draftId` and seed `currentContent` from the draft's
   * persisted content. Returns the seeded content so the caller can hand the
   * same document to the editor as its initial doc - the store is then the
   * single content source (no initial-vs-store dual selection). Flushes any
   * pending write first (it targets the previous binding's own draft, so
   * flushing is always correct).
   */
  readonly openDraft: (draftId: string | null) => JsonContent;
  /**
   * Push a new editor snapshot for the bound draft. Also writes the full content
   * + selection into that draft (creating it on the first non-empty edit of a
   * `null` binding) so draft persistence is a side-effect of typing rather than
   * a callback the parent has to thread.
   */
  readonly setSnapshot: (
    draftId: string | null,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  /**
   * Wipe the snapshot back to an empty document. Called after submission so
   * derived `canSubmit` returns false until the next keystroke.
   */
  readonly reset: () => void;
}

export const useLandingComposerStore = create<LandingComposerStore>(
  (set, get) => ({
    currentContent: EMPTY_CONTENT,
    createdDraftId: null,

    openDraft: (draftId) => {
      flushPendingLandingDraftContent();
      const content =
        draftId === null
          ? EMPTY_CONTENT
          : (useLandingDraftStore
              .getState()
              .drafts.find((draft) => draft.id === draftId)?.content ??
            EMPTY_CONTENT);
      set({ currentContent: content, createdDraftId: null });
      return content;
    },

    setSnapshot: (draftId, content, selection) => {
      const previousContent = get().currentContent;
      set({ currentContent: content });
      // In-editor image removal drops a hash from the live mirror — reconcile so
      // its now-unreferenced bytes are reclaimed (debounced; only when a hash
      // actually left, never on a plain text keystroke).
      if (liveImageHashRemoved(previousContent, content)) {
        scheduleLandingImageReconcile();
      }
      if (draftId !== null) {
        scheduleDraftContentWrite(draftId, content, selection);
        return;
      }
      const draftStore = useLandingDraftStore.getState();
      const createdDraftId = get().createdDraftId;
      if (createdDraftId !== null) {
        // Still pre-remount: keep the just-created draft current synchronously,
        // so the keyed remount reads the latest content.
        draftStore.setDraftContent(createdDraftId, content, selection);
        return;
      }
      const text = extractPlainTextFromComposerJSONContent(content);
      if (text.length === 0 && !containsImageAtoms(content)) return;
      // Creating the draft flips the bound id null -> id, which remounts the
      // composer (keyed by draft id); that mount reads the content back, so this
      // first write must be synchronous or the just-typed content would be lost.
      const id = draftStore.createDraft(
        useComposerRunSettingsStore.getState().globalLastRunSettings,
      );
      draftStore.setDraftContent(id, content, selection);
      set({ createdDraftId: id });
    },

    reset: () => {
      cancelPendingLandingDraftContent();
      set({ currentContent: EMPTY_CONTENT, createdDraftId: null });
    },
  }),
);

/**
 * Set of image hashes referenced by the live editor mirror (the active draft's
 * `currentContent`). The landing image GC (T5) treats these as roots so a
 * just-pasted hash isn't collected before its debounced persisted write lands.
 */
export function landingComposerLiveImageHashes(): ReadonlySet<string> {
  return imageHashesIn(useLandingComposerStore.getState().currentContent);
}

function imageHashesIn(content: JsonContent): Set<string> {
  const hashes = new Set<string>();
  for (const atom of collectImageAtoms(content)) {
    if (atom.hash !== null) hashes.add(atom.hash);
  }
  return hashes;
}

// True when `next` references fewer image hashes than `previous` did — i.e. an
// image node was removed from the editor (not just text edited). Cheap: walks
// only image atoms.
function liveImageHashRemoved(
  previous: JsonContent,
  next: JsonContent,
): boolean {
  const previousHashes = imageHashesIn(previous);
  if (previousHashes.size === 0) return false;
  const nextHashes = imageHashesIn(next);
  for (const hash of previousHashes) {
    if (!nextHashes.has(hash)) return true;
  }
  return false;
}
