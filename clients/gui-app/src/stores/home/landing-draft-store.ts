import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { DraftDocument, DraftPublication } from "@traycer/protocol/host";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/schemas";
import {
  adoptDraftImageHandoff,
  draftImageHashes,
} from "@/lib/composer/landing-image-move";
import { appLogger, describeLogError } from "@/lib/logger";
import { isMobileApp } from "@/lib/mobile-app";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  DEFAULT_COMPOSER_MODE,
  isComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import type {
  DesktopJsonValue,
  DesktopPerWindowLandingDraft,
  DesktopPerWindowSnapshot,
} from "@/lib/windows/types";
import type { DesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  resolvePrimaryPath,
  trimFoldersPreservingPrimary,
} from "@/lib/worktree/resolve-primary-path";
import {
  EMPTY_LANDING_DRAFT_CONTENT,
  sameJsonContent,
} from "./landing-draft-content";
import {
  markLandingDraftsReady,
  markLandingDraftsAuthoritativeNonEmpty,
  scheduleLandingImageReconcile,
} from "@/lib/composer/landing-image-gc";
import { registerLandingDraftRootSource } from "@/lib/composer/landing-image-budget";
import { draftRuntimeRegistry } from "./draft-runtime-registry";
import {
  notifyDraftLocalDelete,
  notifyDraftLocalEdit,
  notifyDraftLocalFlush,
} from "@/lib/drafts/draft-local-edits";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * In-flight "new epic" draft shown in the global tab strip. Multiple drafts
 * may coexist. `activeDraftId` tracks which one the landing-page composer
 * is currently editing.
 */
export interface LandingDraftTab {
  readonly id: string;
  /**
   * Full editor JSON - the persisted source of truth for the draft. Replaces
   * the former lossy `prompt: string`; the tab title is derived from it and the
   * composer seeds the editor from it on mount.
   */
  readonly content: JsonContent;
  /** Cursor position (from/to), mirroring the in-epic composer draft. */
  readonly selection: DraftSelection | null;
  /** Bumped on every content/selection edit; drives LRU eviction (T5). */
  readonly lastTouchedAt: number;
  readonly settings: ChatRunSettings | null;
  readonly composerMode: ComposerMode;
  readonly workspace: LandingDraftWorkspaceSnapshot;
  readonly adoption: LandingDraftAdoption;
  readonly hostRevision: number;
  readonly generation: number;
  readonly syncedGeneration: number;
  readonly ownerHostId: string | null;
  readonly origin: "own" | "replica" | null;
  readonly publication: DraftPublication | null;
  /**
   * Image hashes confirmed on the adopting host via `drafts.putBlob` /
   * `drafts.readBlob`. LRU may drop the local mirror once every live
   * hash is in this set; unconfirmed hashes pin the row so eviction
   * cannot GC bytes that have no host home yet.
   */
  readonly confirmedHostBlobHashes: ReadonlyArray<string>;
  /**
   * Explicit tab-strip membership. Existence in the store no longer implies
   * the draft is open: closing a non-empty start-task draft retains the row
   * and sets this true. Reloads and other devices read the same bit from the
   * draft/v1 portable payload (`closed`), not from a host SQLite column.
   */
  readonly closed: boolean;
}

export type LandingDraftAdoption =
  | { readonly state: "unadopted" }
  | { readonly state: "adopted"; readonly hostId: string };

export const UNADOPTED_LANDING_DRAFT: LandingDraftAdoption = {
  state: "unadopted",
};

export function isOpenLandingDraft(draft: LandingDraftTab): boolean {
  return !draft.closed;
}

/** Local persist cap for adopted mirrors; unadopted drafts are never LRU'd. */
export const MAX_LOCAL_ADOPTED_LANDING_MIRRORS = 30;

// Defined in the dependency-free leaf `./landing-draft-content` (so the store
// import cycle can't TDZ on it); re-exported here for existing importers.
export { EMPTY_LANDING_DRAFT_CONTENT };

export interface LandingDraftWorkspaceSnapshot {
  readonly folders: ReadonlyArray<string>;
  readonly folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>;
  readonly primaryPath: string | null;
}

interface LandingDraftStoreState {
  readonly drafts: ReadonlyArray<LandingDraftTab>;
  readonly activeDraftId: string | null;
  /**
   * Returns an active draft id. Desktop/browser: always creates a fresh
   * draft and sets it active. In the INSTALLED MOBILE APP (`isMobileApp()`),
   * returns the newest existing draft instead - the phone has one stable
   * composer.
   */
  createDraft: (settings: ChatRunSettings | null) => string;
  /**
   * Coordinator-only stable-id source creation (restore/sync, landing
   * null-draft mount key stability) - explicit ids always mint, on every
   * shell.
   */
  createDraftWithId: (id: string, settings: ChatRunSettings | null) => string;
  /**
   * Put a start-task draft away. A non-empty draft is retained (`closed:
   * true`) and leaves the tab strip; an empty one is deleted so stray Cmd-N
   * tabs do not accumulate. If it was the active draft, clears
   * `activeDraftId`; strip-neighbor navigation in the close-flow handles
   * where the user lands.
   */
  closeDraft: (id: string) => void;
  /**
   * Explicit destroy — local row plus host delete when adopted. T11
   * surfaces this; submit/replace-with-epic also uses it. Close does not.
   */
  deleteDraft: (id: string) => void;
  /**
   * Restore a retained draft to the tab strip (`closed: false`) and make
   * it active. T11's "open" action. No-op if id is not in the store.
   */
  openDraft: (id: string) => void;
  /**
   * Drop the local mirror of an adopted draft without deleting the host
   * row. LRU eviction uses this; user close uses `closeDraft`.
   */
  dropLocalMirror: (id: string) => void;
  /** Set the active draft without creating a new one. No-op if id not found or closed. */
  setActiveDraft: (id: string) => void;
  /** Clear the active draft when focus leaves the landing draft surface. */
  clearActiveDraft: () => void;
  /**
   * Replace a draft's full editor content + selection, bumping `lastTouchedAt`.
   * No-op when both content (by value) and selection are unchanged.
   */
  setDraftContent: (
    id: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  /**
   * Persists a caret move alone, bumping `lastTouchedAt` without touching or
   * comparing `content` - a selection-only echo must never re-serialize a
   * (possibly multi-megabyte inline-image) document the way `setDraftContent`
   * does.
   */
  setDraftSelection: (id: string, selection: DraftSelection | null) => void;
  /** Update the run settings of a specific draft. No-op when id not found. */
  setDraftSettings: (id: string, settings: ChatRunSettings) => void;
  /** Update the chat-vs-terminal starting point of a specific draft. */
  setDraftComposerMode: (id: string, mode: ComposerMode) => void;
  // Returns the paths EVICTED by the 50-folder cap (empty when nothing was
  // evicted) so callers can unstage any in-flight worktree intent for them.
  addDraftResolvedFolders: (
    id: string,
    folders: ReadonlyArray<WorkspaceFolderInfo>,
  ) => ReadonlyArray<string>;
  removeDraftFolder: (id: string, folderPath: string) => void;
  setDraftWorkspacePrimary: (id: string, folderPath: string) => void;
  /** Replace the draft workspace with one host's remembered folder bucket. */
  restoreDraftWorkspaceForHost: (id: string, hostId: string | null) => void;
}

export const LANDING_DRAFT_PERSIST_KEY = persistKey(STORE_KEYS.landingDraft);
const MAX_DRAFT_WORKSPACE_FOLDERS = 50;

let localPersistenceEnabled = true;
let desktopProjectionBridge: DesktopPerWindowProjectionBridge | null = null;
let applyingDesktopProjection = false;
let hasAppliedDesktopProjection = false;
/**
 * Draft ids whose image-handoff adoption has been attempted this session.
 * Deliberately NOT "first projection only": adoption must run for whichever
 * projection first carries a given draft, and nothing guarantees that is the
 * first projection overall (subscription order vs the seeded snapshot is an
 * ordering fact, not an invariant). Adoption is already self-gating on
 * locally-missing hashes; this set only stops per-draft re-probing.
 */
const imageAdoptionAttemptedDraftIds = new Set<string>();

const landingDraftStorage: StateStorage = {
  getItem: (name) => window.localStorage.getItem(name),
  setItem: (name, value) => {
    if (!localPersistenceEnabled) return;
    window.localStorage.setItem(name, value);
  },
  removeItem: (name) => {
    window.localStorage.removeItem(name);
  },
};
function setLandingDraftLocalPersistenceEnabled(enabled: boolean): void {
  localPersistenceEnabled = enabled;
}

export function setLandingDraftDesktopProjectionBridge(
  bridge: DesktopPerWindowProjectionBridge | null,
): void {
  desktopProjectionBridge = bridge;
  hasAppliedDesktopProjection = false;
  imageAdoptionAttemptedDraftIds.clear();
  setLandingDraftLocalPersistenceEnabled(bridge === null);
}

export function applyLandingDraftDesktopProjection(
  snapshot: DesktopPerWindowSnapshot,
): void {
  const drafts = uniqueLandingDrafts(readProjectedDrafts(snapshot));
  const activeDraftId = readProjectedActiveDraftId(snapshot, drafts);
  const currentState = useLandingDraftStore.getState();
  // [B1] Empty-inbound clobber guard. The FIRST desktop projection is always
  // authoritative, even when empty: pre-hydration in-memory drafts may be stale
  // localStorage state from an earlier web-mode run. After that hydrate, landing
  // drafts are per-window and this window's live in-memory state is authoritative,
  // so a later EMPTY inbound snapshot must not replace NON-EMPTY live drafts.
  // Left unguarded, a spurious clear (registry churn) would wipe an alive draft
  // AND — via `markLandingDraftsReady` → reconcile with now-empty roots — reap
  // its persisted image bytes. Re-project the in-memory truth outbound so disk
  // reconverges, and do NOT flip the ready gate on this bad later inbound (its
  // roots are wrong).
  if (
    hasAppliedDesktopProjection &&
    drafts.length === 0 &&
    currentState.drafts.length > 0
  ) {
    projectLandingDraftsToDesktop(currentState);
    return;
  }
  applyingDesktopProjection = true;
  // try/finally so a throw in setState/equality can never leave the flag stuck
  // `true` — which would permanently suppress all outbound projections.
  try {
    useLandingDraftStore.setState((state) => {
      if (
        state.activeDraftId === activeDraftId &&
        areLandingDraftsEqual(state.drafts, drafts)
      ) {
        return state;
      }
      return {
        drafts,
        activeDraftId,
      };
    });
  } finally {
    applyingDesktopProjection = false;
  }
  hasAppliedDesktopProjection = true;
  // A draft MOVED here from another window arrives with hash-only content
  // whose bytes live in the SOURCE window's partition; the source staged them
  // in a per-draft handoff DB before the move. Adoption is self-gating (it
  // only opens the handoff when a hash is actually missing locally), so this
  // is a no-op for ordinary restores; the attempted-set just keeps it to one
  // probe per draft per session. A FAILED probe releases its entry: an
  // IndexedDB read that lost to a transient error must be retried on the next
  // projection, otherwise a moved draft's images stay unavailable for the rest
  // of the session even though the handoff is still sitting there.
  for (const draft of drafts) {
    if (imageAdoptionAttemptedDraftIds.has(draft.id)) continue;
    imageAdoptionAttemptedDraftIds.add(draft.id);
    void adoptDraftImageHandoff(
      draft.id,
      draftImageHashes(draft.content),
    ).catch((error: unknown) => {
      imageAdoptionAttemptedDraftIds.delete(draft.id);
      appLogger.warn("[landing-draft] draft-move image adoption failed", {
        draftId: draft.id,
        error: describeLogError(error),
      });
    });
  }
  // [B2] A non-empty authoritative snapshot confirms the landing roots are real,
  // so the GC's deleting sweep may run (reaping genuine orphans) without risking
  // freshly-restored bytes.
  if (drafts.length > 0) markLandingDraftsAuthoritativeNonEmpty();
  // [C1] Desktop drafts arrive asynchronously over IPC, so the orphan sweep is
  // gated until they do: the FIRST projection means the draft set is now known.
  markLandingDraftsReady();
}

function readProjectedDrafts(
  snapshot: DesktopPerWindowSnapshot,
): ReadonlyArray<LandingDraftTab> {
  return snapshot.landingDrafts.flatMap((draft) => {
    // T6: the desktop payload now carries real rich content (hash-only image
    // nodes, mentions, marks). A draft whose `content` fails the doc-shape
    // guard is dropped - strict, no fallback (no back-compat; dev feature).
    const content = parseLandingDraftContent(draft.content);
    if (content === null) return [];
    return [
      {
        id: draft.id,
        content,
        selection: parseLandingDraftSelection(draft.selection),
        lastTouchedAt: parseLandingDraftLastTouchedAt(draft.lastTouchedAt),
        settings: parseChatRunSettings(draft.settings),
        composerMode: parseComposerMode(draft.composerMode),
        workspace: parseLandingDraftWorkspaceSnapshot(draft.workspace),
        ...mirrorFieldsFromExisting(draft.id),
        closed: draft.closed === true,
      },
    ];
  });
}

/**
 * Accept only doc-shaped editor JSON as restorable content. Implemented as a
 * type guard (param `unknown`, predicate `value is JsonContent`) so the inbound
 * `DesktopJsonValue` narrows to `JsonContent` losslessly - no `as`. Anything
 * that is not a `{ type: "doc", ... }` record (a legacy prompt-only entry, a
 * primitive, an array) is rejected.
 */
function parseLandingDraftContent(value: DesktopJsonValue): JsonContent | null {
  return isLandingDraftDocContent(value) ? value : null;
}

function isLandingDraftDocContent(value: unknown): value is JsonContent {
  // Require `content` to be an array (or absent): a malformed `{ type: "doc",
  // content: <non-array> }` would otherwise narrow to JsonContent and throw when
  // `plainTextFromNodes` walks it during tab-strip render (`draftTabName`).
  return (
    isRecord(value) &&
    value.type === "doc" &&
    (value.content === undefined || Array.isArray(value.content))
  );
}

function parseLandingDraftSelection(value: unknown): DraftSelection | null {
  if (!isRecord(value)) return null;
  const { from, to } = value;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isFinite(from) ||
    !Number.isFinite(to)
  ) {
    return null;
  }
  return { from, to };
}

function parseLandingDraftLastTouchedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Date.now();
}

function readProjectedActiveDraftId(
  snapshot: DesktopPerWindowSnapshot,
  drafts: ReadonlyArray<LandingDraftTab>,
): string | null {
  const activeDraftId = snapshot.activeLandingDraftId;
  if (activeDraftId === null) return null;
  return drafts.some((draft) => draft.id === activeDraftId && !draft.closed)
    ? activeDraftId
    : null;
}

/**
 * Validate the localStorage-persisted `drafts` array on rehydration, mirroring
 * `readProjectedDrafts` (the desktop-projection path): each draft is rebuilt
 * field-by-field, a draft whose `content` fails the doc-shape guard is dropped,
 * and a missing/invalid `workspace` becomes the empty snapshot (so
 * `draft.workspace.folders` is always readable). Without this, the persist
 * middleware rehydrated `drafts` verbatim, so a legacy tab (pre-`content`
 * retype, or pre-`workspace`) crashed the landing render on `draft.workspace`.
 */
function parsePersistedLandingDrafts(
  value: unknown,
): ReadonlyArray<LandingDraftTab> {
  if (!Array.isArray(value)) return [];
  return uniqueLandingDrafts(
    value.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const id = raw.id;
      const content = raw.content;
      if (typeof id !== "string" || !isLandingDraftDocContent(content)) {
        return [];
      }
      return [
        {
          id,
          content,
          selection: parseLandingDraftSelection(raw.selection),
          lastTouchedAt: parseLandingDraftLastTouchedAt(raw.lastTouchedAt),
          settings: parseChatRunSettings(raw.settings),
          composerMode: parsePersistedComposerMode(raw.composerMode),
          workspace: parseLandingDraftWorkspaceSnapshot(raw.workspace),
          ...parseLandingMirrorFields(raw),
          closed: raw.closed === true,
        },
      ];
    }),
  );
}

function parsePersistedActiveDraftId(
  value: unknown,
  drafts: ReadonlyArray<LandingDraftTab>,
): string | null {
  if (typeof value !== "string") return null;
  return drafts.some((draft) => draft.id === value && !draft.closed)
    ? value
    : null;
}

// Rehydration-safe composer-mode parse. Unlike `parseComposerMode` (which seeds
// a missing value from the live settings store), this stays self-contained: the
// persist `merge` runs during synchronous module-init rehydration, so it must
// not reach into another store, and falls back to the static default.
function parsePersistedComposerMode(value: unknown): ComposerMode {
  return typeof value === "string" && isComposerMode(value)
    ? value
    : DEFAULT_COMPOSER_MODE;
}

function destroyLandingDraft(
  get: () => LandingDraftStoreState,
  set: (partial: Partial<LandingDraftStoreState>) => void,
  id: string,
): void {
  const { drafts, activeDraftId } = get();
  const closing = drafts.find((d) => d.id === id);
  if (closing === undefined) return;
  draftRuntimeRegistry.close(id);
  // Route the host delete while the row still exists: `routeLocalDelete`
  // resolves the session via `hostIdForDraft`, which reads this store.
  if (closing.adoption.state === "adopted") {
    notifyDraftLocalDelete(id);
  }
  set({
    drafts: drafts.filter((d) => d.id !== id),
    activeDraftId: activeDraftId === id ? null : activeDraftId,
  });
  scheduleLandingImageReconcile();
}

/**
 * Content-derived emptiness: no typed text AND no image atoms. An image-only
 * draft is real content - discarding or replacing it would drop the image.
 */
export function isLandingDraftEmpty(draft: LandingDraftTab): boolean {
  return isEmptyLandingDraftContent(draft.content);
}

/**
 * Newest OPEN landing draft, for the installed mobile app's single stable
 * composer: an id-less "new draft" activation reuses this instead of minting
 * (see `createDraft`). `null` when no open draft exists. A closed draft is
 * retained-but-hidden (see `closeDraft`) and is never resurrected implicitly;
 * it comes back only through `openDraft`.
 */
export function newestLandingDraftId(): string | null {
  return newestDraft(useLandingDraftStore.getState().drafts);
}

function newestDraft(drafts: ReadonlyArray<LandingDraftTab>): string | null {
  let newest: LandingDraftTab | null = null;
  for (const draft of drafts) {
    if (!isOpenLandingDraft(draft)) continue;
    // >= so the LATER array entry wins a millisecond tie: drafts are
    // append-ordered, and same-ms timestamps are realistic (restore paths
    // stamp several drafts in one tick).
    if (newest === null || draft.lastTouchedAt >= newest.lastTouchedAt) {
      newest = draft;
    }
  }
  return newest === null ? null : newest.id;
}

export const useLandingDraftStore = create<LandingDraftStoreState>()(
  persist(
    (set, get) => ({
      drafts: [],
      activeDraftId: null,

      createDraft: (settings) => {
        // The installed mobile app has ONE stable composer: its header has
        // no tab strip, so a second draft tab could never be closed. "New
        // task" therefore lands back on the existing draft - whatever its
        // content - instead of minting another. Keyed on the PRODUCT flag,
        // never the viewport (see `@/lib/mobile-app`): a responsively-narrow
        // desktop browser keeps normal multi-draft behavior. Explicit-id
        // creation (`createDraftWithId`) is a restore/sync path and always
        // mints exactly that draft.
        if (isMobileApp()) {
          const existing = newestDraft(get().drafts);
          if (existing !== null) {
            set({ activeDraftId: existing });
            return existing;
          }
        }
        return get().createDraftWithId(uuidv4(), settings);
      },

      createDraftWithId: (id, settings) => {
        if (get().drafts.some((draft) => draft.id === id)) return id;
        const next: LandingDraftTab = {
          id,
          content: EMPTY_LANDING_DRAFT_CONTENT,
          selection: null,
          lastTouchedAt: Date.now(),
          settings: copyChatRunSettings(settings),
          // Seed from the global last-used mode; the draft owns it from here.
          composerMode: useSettingsStore.getState().composerMode,
          workspace: readCurrentLandingDraftWorkspaceSnapshot(),
          ...freshLandingMirrorState(),
        };
        set((state) => ({
          drafts: [...uniqueLandingDrafts(state.drafts), next],
          activeDraftId: next.id,
        }));
        return next.id;
      },

      closeDraft: (id) => {
        if (!get().drafts.some((d) => d.id === id)) return;
        // Flush pending runtime writes first so emptiness is judged on the
        // canonical document, not a still-debounced keystroke.
        draftRuntimeRegistry.close(id);
        const closing = get().drafts.find((d) => d.id === id);
        if (closing === undefined) return;
        if (isEmptyLandingDraftContent(closing.content)) {
          destroyLandingDraft(get, set, id);
          return;
        }
        if (closing.closed) {
          if (get().activeDraftId === id) set({ activeDraftId: null });
          return;
        }
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id
              ? { ...d, closed: true, generation: d.generation + 1 }
              : d,
          ),
          activeDraftId:
            state.activeDraftId === id ? null : state.activeDraftId,
        }));
        notifyDraftLocalEdit(id);
        notifyDraftLocalFlush(id);
        // Retained drafts stay in `currentDrafts()` so this sweep must not
        // reap their image hashes. The call still drops session entries of
        // a runtime that just closed.
        scheduleLandingImageReconcile();
      },

      deleteDraft: (id) => {
        destroyLandingDraft(get, set, id);
      },

      openDraft: (id) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (draft === undefined) return;
        // A pending create keeps the runtime alive through close. Reopen
        // here is defensive — `openDraft` is synchronous and nothing between
        // these two reads settlement — so a retained in-flight runtime is
        // not handed back still closed.
        draftRuntimeRegistry.reopen(id);
        if (!draft.closed) {
          set({ activeDraftId: id });
          return;
        }
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id
              ? { ...d, closed: false, generation: d.generation + 1 }
              : d,
          ),
          activeDraftId: id,
        }));
        notifyDraftLocalEdit(id);
        notifyDraftLocalFlush(id);
      },

      dropLocalMirror: (id) => {
        const { drafts, activeDraftId } = get();
        const current = drafts.find((d) => d.id === id);
        if (current === undefined || current.adoption.state !== "adopted") {
          return;
        }
        draftRuntimeRegistry.close(id);
        set({
          drafts: drafts.filter((d) => d.id !== id),
          activeDraftId: activeDraftId === id ? null : activeDraftId,
        });
        scheduleLandingImageReconcile();
      },

      setActiveDraft: (id) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (draft === undefined || draft.closed) return;
        set({ activeDraftId: id });
      },

      clearActiveDraft: () => {
        if (get().activeDraftId === null) return;
        set({ activeDraftId: null });
      },

      setDraftContent: (id, content, selection) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (!draft) return;
        // The in-memory draft content is CANONICAL: it is both the source the
        // serializers read AND the source `openDraft` re-seeds the keyed remount
        // from, so it must keep a paste's still-pending b64 node verbatim — an
        // in-session navigate-away-and-back re-ingests that node (mount-time
        // re-entry in `landing-composer`). The "persisted landing drafts never
        // carry base64" invariant [Mechanism A] is enforced at the two true
        // serialization seams instead — the persist `partialize` and
        // `projectLandingDraftForDesktop` — never here (a store that feeds a
        // remount is not a serialization sink).
        if (
          sameJsonContent(draft.content, content) &&
          sameDraftSelection(draft.selection, selection)
        ) {
          return;
        }
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id
              ? {
                  ...d,
                  content,
                  selection,
                  lastTouchedAt: Date.now(),
                  generation: d.generation + 1,
                }
              : d,
          ),
        }));
        notifyDraftLocalEdit(id);
      },

      setDraftSelection: (id, selection) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (!draft) return;
        if (sameDraftSelection(draft.selection, selection)) return;
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id
              ? {
                  ...d,
                  selection,
                  lastTouchedAt: Date.now(),
                  generation: d.generation + 1,
                }
              : d,
          ),
        }));
        notifyDraftLocalEdit(id);
      },

      setDraftSettings: (id, settings) => {
        set((state) => {
          const draft = state.drafts.find((d) => d.id === id);
          if (draft === undefined) return state;
          if (
            draft.settings !== null &&
            sameChatRunSettings(draft.settings, settings)
          ) {
            return state;
          }
          return {
            drafts: state.drafts.map((d) =>
              d.id === id
                ? {
                    ...d,
                    settings: { ...settings },
                    generation: d.generation + 1,
                  }
                : d,
            ),
          };
        });
        notifyDraftLocalEdit(id);
      },

      setDraftComposerMode: (id, mode) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (!draft || draft.composerMode === mode) return;
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id
              ? { ...d, composerMode: mode, generation: d.generation + 1 }
              : d,
          ),
        }));
        notifyDraftLocalEdit(id);
      },

      restoreDraftWorkspaceForHost: (id, hostId) => {
        const bucket = selectWorkspaceFoldersBucket(
          useWorkspaceFoldersStore.getState(),
          hostId,
        );
        set((state) =>
          updateDraftWorkspace(state, id, () =>
            normalizeLandingDraftWorkspace({
              folders: [...bucket.folders],
              folderInfoByPath: copyWorkspaceFolderInfoByPath(
                bucket.folderInfoByPath,
              ),
              primaryPath: bucket.primaryPath,
            }),
          ),
        );
      },

      addDraftResolvedFolders: (id, folders) => {
        const before =
          get().drafts.find((d) => d.id === id)?.workspace.folders ?? [];
        set((state) =>
          updateDraftWorkspace(state, id, (workspace) =>
            mergeLandingDraftWorkspaceFolders(workspace, folders),
          ),
        );
        const afterSet = new Set(
          get().drafts.find((d) => d.id === id)?.workspace.folders ?? [],
        );
        notifyDraftLocalEdit(id);
        return before.filter((path) => !afterSet.has(path));
      },

      removeDraftFolder: (id, folderPath) => {
        set((state) =>
          updateDraftWorkspace(state, id, (workspace) =>
            removeLandingDraftWorkspaceFolder(workspace, folderPath),
          ),
        );
        notifyDraftLocalEdit(id);
      },

      setDraftWorkspacePrimary: (id, folderPath) => {
        set((state) =>
          updateDraftWorkspace(state, id, (workspace) =>
            setLandingDraftWorkspacePrimary(workspace, folderPath),
          ),
        );
        notifyDraftLocalEdit(id);
      },
    }),
    {
      ...basePersistOptions(LANDING_DRAFT_PERSIST_KEY),
      storage: createJSONStorage(() => landingDraftStorage),
      // Serialization boundary [Mechanism A]: persisted landing drafts NEVER
      // carry base64. The in-memory `drafts` array is canonical and DOES hold a
      // paste's still-pending b64 node (so an in-session navigate-away-and-back
      // re-ingests it — mount-time re-entry in `landing-composer`); the strip
      // lives ONLY here, at the localStorage seam, and in
      // `projectLandingDraftForDesktop` (the desktop seam). A hash-only node,
      // whose bytes are durably stored, always survives.
      // ACCEPTED IMPERFECTION: process exit (quit or crash) during the sub-second
      // ingest window omits that paste's still-pending image from the serialized
      // draft, because its b64 node has not yet converted to a hash.
      partialize: (state) => ({
        drafts: state.drafts.map((draft) => ({
          ...draft,
          content: stripBase64ImageNodes(draft.content),
        })),
        activeDraftId: state.activeDraftId,
      }),
      // Sanitize the localStorage payload on rehydration the same way
      // `readProjectedDrafts` sanitizes the desktop projection, so a legacy tab
      // (pre-`content` retype / pre-`workspace`) can't rehydrate a shape whose
      // `draft.workspace.folders` read throws. The default shallow merge took
      // `drafts` verbatim.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        const drafts = parsePersistedLandingDrafts(persisted.drafts);
        return {
          ...currentState,
          drafts,
          activeDraftId: parsePersistedActiveDraftId(
            persisted.activeDraftId,
            drafts,
          ),
        };
      },
    },
  ),
);

// The registry intentionally has no import back into this persisted source.
// Wiring it after store construction keeps the renderer-local runtime free of
// store module cycles and makes recovery hydrate only this window's drafts.
draftRuntimeRegistry.configure({
  read: (draftId) => {
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === draftId);
    return draft === undefined
      ? null
      : { content: draft.content, selection: draft.selection };
  },
  write: (draftId, content, selection) => {
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId, content, selection);
  },
  writeSelection: (draftId, selection) => {
    useLandingDraftStore.getState().setDraftSelection(draftId, selection);
  },
});

// Same reasoning as the registry wiring above: `landing-image-budget.ts`
// intentionally has no import back into this persisted source (it would
// close a store → gc → budget → store cycle), so it reads drafts through
// this registration instead.
registerLandingDraftRootSource({
  drafts: () => useLandingDraftStore.getState().drafts,
});
/**
 * Render-stable projection of the active draft for the landing-page shell
 * (`HomePage`). Subscribes ONLY to the fields that affect layout/identity - the
 * draft `id`, its workspace folder list, and run settings - each of which keeps
 * a stable reference across a `setDraftContent` edit (the action spreads
 * `{ ...draft, content, selection, lastTouchedAt }`, leaving `workspace` and
 * `settings` references intact).
 *
 * The live `content` is deliberately excluded: it changes on every keystroke
 * and is only needed at composer mount time (`LandingComposer` reads it once,
 * keyed by draft id). Subscribing to it here would re-render the whole home
 * surface - hero, composer, toolbar, workspace row, epics list - per character,
 * which is exactly the flicker this selector removes.
 */
export function useActiveLandingDraftShell(): {
  readonly draftId: string | null;
  readonly workspaceFolders: ReadonlyArray<string> | null;
  readonly settings: ChatRunSettings | null;
} {
  const activeDraftId = useLandingDraftStore((state) => state.activeDraftId);
  return useLandingDraftShell(activeDraftId);
}

/** Stable draft-shell projection for one retained top-level draft surface. */
export function useLandingDraftShell(draftId: string | null): {
  readonly draftId: string | null;
  readonly workspaceFolders: ReadonlyArray<string> | null;
  readonly settings: ChatRunSettings | null;
} {
  return useLandingDraftStore(
    useShallow((state) => {
      const draft = state.drafts.find((d) => d.id === draftId) ?? null;
      return {
        draftId: draft?.id ?? null,
        workspaceFolders: draft?.workspace.folders ?? null,
        settings: draft?.settings ?? null,
      };
    }),
  );
}

function areLandingDraftsEqual(
  left: ReadonlyArray<LandingDraftTab>,
  right: ReadonlyArray<LandingDraftTab>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id) return false;
    // [Rev2/H2] Compare content + selection BY VALUE, excluding `lastTouchedAt`.
    // The inbound desktop projection rebuilds `content` (and stamps a fresh
    // timestamp) every echo; reference/timestamp comparison would never
    // short-circuit, so every echo would replace state and re-derive titles.
    if (!sameJsonContent(left[index].content, right[index].content)) {
      return false;
    }
    if (!sameDraftSelection(left[index].selection, right[index].selection)) {
      return false;
    }
    if (left[index].composerMode !== right[index].composerMode) return false;
    if (
      !sameNullableChatRunSettings(left[index].settings, right[index].settings)
    ) {
      return false;
    }
    if (
      !sameLandingDraftWorkspace(left[index].workspace, right[index].workspace)
    ) {
      return false;
    }
    if (left[index].closed !== right[index].closed) return false;
  }
  return true;
}

function uniqueLandingDrafts(
  drafts: ReadonlyArray<LandingDraftTab>,
): ReadonlyArray<LandingDraftTab> {
  const seen = new Set<string>();
  return drafts.flatMap((draft) => {
    if (seen.has(draft.id)) return [];
    seen.add(draft.id);
    return [draft];
  });
}

// Project the current in-memory drafts to the desktop per-window store. Used by
// the store subscription (on every local edit) AND by the [B1] empty-inbound
// guard, which re-projects truth so a spurious empty snapshot on disk is
// overwritten. Safe to call directly during a guard trip: it does not touch the
// `applyingDesktopProjection` flag, and main suppresses the echo of a window's
// own update, so no inbound loop results.
function projectLandingDraftsToDesktop(state: LandingDraftStoreState): void {
  if (desktopProjectionBridge === null) return;
  void desktopProjectionBridge.update({
    landingDrafts: state.drafts.map(projectLandingDraftForDesktop),
    activeLandingDraftId: state.activeDraftId,
  });
}

useLandingDraftStore.subscribe((state) => {
  if (desktopProjectionBridge === null || applyingDesktopProjection) return;
  projectLandingDraftsToDesktop(state);
});

function projectLandingDraftForDesktop(
  draft: LandingDraftTab,
): DesktopPerWindowLandingDraft {
  return {
    id: draft.id,
    // T6: emit the real hash-only editor JSON, the cursor, and the edit time.
    // Desktop serialization seam [Mechanism A]: strip a paste's still-pending b64
    // node first so the projected draft is hash-only — this covers BOTH the store
    // subscription and the [B1] empty-inbound guard re-projection (both route
    // through here). Same narrowed accepted imperfection as the persist
    // `partialize`. `content` is plain JSON already; the walker reproduces it as a
    // `DesktopJsonValue` without a cast (`JsonContent`'s `unknown`-valued attrs
    // are not structurally assignable to `DesktopJsonValue`).
    content: landingDraftContentToDesktopValue(
      stripBase64ImageNodes(draft.content),
    ),
    // `DraftSelection` lacks an index signature, so rebuild it as a fresh
    // record literal (numbers) to satisfy `DesktopJsonValue` without a cast.
    selection:
      draft.selection === null
        ? null
        : { from: draft.selection.from, to: draft.selection.to },
    lastTouchedAt: draft.lastTouchedAt,
    settings: chatRunSettingsToDesktopValue(draft.settings),
    composerMode: draft.composerMode,
    workspace: landingDraftWorkspaceToDesktopValue(draft.workspace),
    closed: draft.closed,
  };
}

/**
 * Reproduce the editor JSON as a `DesktopJsonValue`. The content is hash-only
 * plain JSON, but `JsonContent`'s `Record<string, unknown>` attrs make it
 * structurally unassignable to `DesktopJsonValue`, so walk it (mirroring the
 * desktop-side `parseJsonValue`) instead of casting. Bounded - no base64.
 */
function landingDraftContentToDesktopValue(
  content: JsonContent,
): DesktopJsonValue {
  return toDesktopJsonValue(content);
}

function toDesktopJsonValue(value: unknown): DesktopJsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      entry === undefined ? [] : [toDesktopJsonValue(entry)],
    );
  }
  if (isRecord(value)) {
    const out: Record<string, DesktopJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = toDesktopJsonValue(entry);
    }
    return out;
  }
  return null;
}

function parseComposerMode(value: unknown): ComposerMode {
  if (typeof value === "string" && isComposerMode(value)) return value;
  // Drafts persisted before `composerMode` existed (or carrying an unknown
  // value) adopt the user's global last-used mode - the same seed a fresh
  // draft gets in `createDraft`. The settings store hydrates synchronously
  // from localStorage, so it is readable by the time drafts are restored.
  return useSettingsStore.getState().composerMode;
}

function parseChatRunSettings(value: unknown): ChatRunSettings | null {
  if (value === null || value === undefined) return null;
  const parsed = chatRunSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function copyChatRunSettings(
  settings: ChatRunSettings | null,
): ChatRunSettings | null {
  return settings === null ? null : { ...settings };
}

function sameNullableChatRunSettings(
  left: ChatRunSettings | null,
  right: ChatRunSettings | null,
): boolean {
  if (left === null || right === null) return left === right;
  return sameChatRunSettings(left, right);
}

function sameChatRunSettings(a: ChatRunSettings, b: ChatRunSettings): boolean {
  return (
    JSON.stringify(normalizeChatRunSettings(a)) ===
    JSON.stringify(normalizeChatRunSettings(b))
  );
}

function chatRunSettingsToDesktopValue(
  settings: ChatRunSettings | null,
): DesktopJsonValue | null {
  return settings === null ? null : normalizeChatRunSettings(settings);
}

function normalizeChatRunSettings(
  settings: ChatRunSettings,
): Record<string, DesktopJsonValue> {
  return {
    harnessId: settings.harnessId,
    model: settings.model,
    permissionMode: settings.permissionMode,
    reasoningEffort: settings.reasoningEffort,
    serviceTier: settings.serviceTier,
    agentMode: settings.agentMode,
  };
}

function readCurrentLandingDraftWorkspaceSnapshot(): LandingDraftWorkspaceSnapshot {
  // A new draft is created on the landing surface, which follows the
  // app-wide effective host - snapshot THAT host's folder bucket, not another
  // machine's paths. Through the shared reader: the spine stopped carrying an
  // identity at P4.2, so asking it here selected the unresolved-host bucket
  // and silently dropped the real host's folders.
  const bucket = selectWorkspaceFoldersBucket(
    useWorkspaceFoldersStore.getState(),
    activeHostIdOrNull(),
  );
  return normalizeLandingDraftWorkspace({
    folders: [...bucket.folders],
    folderInfoByPath: copyWorkspaceFolderInfoByPath(bucket.folderInfoByPath),
    primaryPath: bucket.primaryPath,
  });
}

export function emptyLandingDraftWorkspaceSnapshot(): LandingDraftWorkspaceSnapshot {
  return {
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  };
}

function updateDraftWorkspace(
  state: LandingDraftStoreState,
  id: string,
  update: (
    workspace: LandingDraftWorkspaceSnapshot,
  ) => LandingDraftWorkspaceSnapshot,
): LandingDraftStoreState | Pick<LandingDraftStoreState, "drafts"> {
  const draft = state.drafts.find((d) => d.id === id);
  if (draft === undefined) return state;
  const nextWorkspace = update(draft.workspace);
  if (sameLandingDraftWorkspace(draft.workspace, nextWorkspace)) return state;
  return {
    drafts: state.drafts.map((d) =>
      d.id === id
        ? { ...d, workspace: nextWorkspace, generation: d.generation + 1 }
        : d,
    ),
  };
}

export function mergeLandingDraftWorkspaceFolders(
  workspace: LandingDraftWorkspaceSnapshot,
  folders: ReadonlyArray<WorkspaceFolderInfo>,
): LandingDraftWorkspaceSnapshot {
  const accumulator = {
    folders: [...workspace.folders],
    folderSet: new Set(workspace.folders),
    folderInfoByPath: copyWorkspaceFolderInfoByPath(workspace.folderInfoByPath),
    changed: false,
  };
  for (const folder of folders) {
    const path = folder.path.trim();
    if (path.length === 0) continue;
    if (!accumulator.folderSet.has(path)) {
      accumulator.folders.push(path);
      accumulator.folderSet.add(path);
      accumulator.changed = true;
    }
    const existing = Object.hasOwn(accumulator.folderInfoByPath, path)
      ? accumulator.folderInfoByPath[path]
      : null;
    if (
      existing === null ||
      existing.name !== folder.name ||
      existing.hostId !== folder.hostId ||
      !sameRepoIdentifier(existing.repoIdentifier, folder.repoIdentifier)
    ) {
      accumulator.folderInfoByPath[path] = {
        path,
        name: folder.name,
        repoIdentifier: copyRepoIdentifier(folder.repoIdentifier),
        hostId: folder.hostId,
      };
      accumulator.changed = true;
    }
  }
  if (!accumulator.changed) return workspace;
  return normalizeLandingDraftWorkspace({
    ...workspace,
    folders: accumulator.folders,
    folderInfoByPath: accumulator.folderInfoByPath,
  });
}

export function removeLandingDraftWorkspaceFolder(
  workspace: LandingDraftWorkspaceSnapshot,
  folderPath: string,
): LandingDraftWorkspaceSnapshot {
  if (!workspace.folders.includes(folderPath)) return workspace;
  const nextInfoByPath = { ...workspace.folderInfoByPath };
  delete nextInfoByPath[folderPath];
  const nextFolders = workspace.folders.filter((path) => path !== folderPath);
  return {
    ...workspace,
    folders: nextFolders,
    folderInfoByPath: nextInfoByPath,
    // Deterministic fallback to the first remaining folder when the removed
    // folder WAS the explicit primary; `resolvePrimaryPath` also covers the
    // "no folders left" case (`null`).
    primaryPath: resolvePrimaryPath(nextFolders, workspace.primaryPath),
  };
}

/**
 * Sets the explicit primary folder for a draft/modal workspace snapshot,
 * matching the `mergeLandingDraftWorkspaceFolders` / `removeLandingDraft-
 * WorkspaceFolder` pure-helper pattern so every action (draft store, modal
 * store) routes through one implementation. No-op (same reference) when
 * `folderPath` isn't a member of the snapshot, or is already primary.
 */
export function setLandingDraftWorkspacePrimary(
  workspace: LandingDraftWorkspaceSnapshot,
  folderPath: string,
): LandingDraftWorkspaceSnapshot {
  if (!workspace.folders.includes(folderPath)) return workspace;
  if (workspace.primaryPath === folderPath) return workspace;
  return { ...workspace, primaryPath: folderPath };
}

function parseLandingDraftWorkspaceSnapshot(
  value: unknown,
): LandingDraftWorkspaceSnapshot {
  if (!isRecord(value)) return emptyLandingDraftWorkspaceSnapshot();
  const folderInfoByPath = parseWorkspaceFolderInfoByPath(
    value.folderInfoByPath,
  );
  const folders = parseWorkspaceFolders(value.folders, folderInfoByPath);
  return normalizeLandingDraftWorkspace({
    folders,
    folderInfoByPath,
    primaryPath: parsePersistedPrimaryPath(value.primaryPath),
  });
}

function parsePersistedPrimaryPath(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseWorkspaceFolders(
  value: unknown,
  folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    if (!Object.hasOwn(folderInfoByPath, entry)) return [];
    if (seen.has(entry)) return [];
    seen.add(entry);
    return [entry];
  });
}

function parseWorkspaceFolderInfoByPath(
  value: unknown,
): Readonly<Record<string, WorkspaceFolderInfo>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([path, entry]) => {
      const parsed = parseWorkspaceFolderInfo(entry, path);
      return parsed === null ? [] : [[path, parsed]];
    }),
  );
}

function parseWorkspaceFolderInfo(
  value: unknown,
  expectedPath: string,
): WorkspaceFolderInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (value.path !== expectedPath) return null;
  const hostId =
    typeof value.hostId === "string" && value.hostId.length > 0
      ? value.hostId
      : null;
  return {
    path: value.path,
    name: value.name,
    repoIdentifier: parseRepoIdentifier(value.repoIdentifier),
    hostId,
  };
}

function parseRepoIdentifier(
  value: unknown,
): WorkspaceFolderInfo["repoIdentifier"] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  if (typeof value.owner !== "string" || typeof value.repo !== "string") {
    return null;
  }
  return { owner: value.owner, repo: value.repo };
}

function normalizeLandingDraftWorkspace(
  workspace: LandingDraftWorkspaceSnapshot,
): LandingDraftWorkspaceSnapshot {
  // Cap eviction must never silently move primary: trim the oldest
  // SECONDARY folders first, keeping the resolved primary's slot intact.
  const folders = trimFoldersPreservingPrimary(
    workspace.folders,
    workspace.primaryPath,
    MAX_DRAFT_WORKSPACE_FOLDERS,
  );
  const folderSet = new Set(folders);
  return {
    ...workspace,
    folders,
    folderInfoByPath: filterWorkspaceFolderInfoToFolders(
      workspace.folderInfoByPath,
      folderSet,
    ),
    primaryPath: resolvePrimaryPath(folders, workspace.primaryPath),
  };
}

function filterWorkspaceFolderInfoToFolders(
  infoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
  folderSet: ReadonlySet<string>,
): Record<string, WorkspaceFolderInfo> {
  return Object.fromEntries(
    Object.entries(infoByPath).flatMap(([path, info]) =>
      folderSet.has(path) ? [[path, info]] : [],
    ),
  );
}

function copyWorkspaceFolderInfoByPath(
  infoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
): Record<string, WorkspaceFolderInfo> {
  return Object.fromEntries(
    Object.entries(infoByPath).map(([path, info]) => [
      path,
      {
        path: info.path,
        name: info.name,
        repoIdentifier: copyRepoIdentifier(info.repoIdentifier),
        hostId: info.hostId,
      },
    ]),
  );
}

function copyRepoIdentifier(
  repoIdentifier: WorkspaceFolderInfo["repoIdentifier"],
): WorkspaceFolderInfo["repoIdentifier"] {
  return repoIdentifier === null
    ? null
    : { owner: repoIdentifier.owner, repo: repoIdentifier.repo };
}

function sameLandingDraftWorkspace(
  a: LandingDraftWorkspaceSnapshot,
  b: LandingDraftWorkspaceSnapshot,
): boolean {
  return (
    a.primaryPath === b.primaryPath &&
    sameStringArrays(a.folders, b.folders) &&
    sameWorkspaceFolderInfoByPath(a.folderInfoByPath, b.folderInfoByPath)
  );
}

function sameStringArrays(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameWorkspaceFolderInfoByPath(
  a: Readonly<Record<string, WorkspaceFolderInfo>>,
  b: Readonly<Record<string, WorkspaceFolderInfo>>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (!sameStringArrays(aKeys, bKeys)) return false;
  return aKeys.every((key) => {
    const aInfo = a[key];
    const bInfo = b[key];
    return (
      aInfo.path === bInfo.path &&
      aInfo.name === bInfo.name &&
      aInfo.hostId === bInfo.hostId &&
      sameRepoIdentifier(aInfo.repoIdentifier, bInfo.repoIdentifier)
    );
  });
}

function sameRepoIdentifier(
  a: WorkspaceFolderInfo["repoIdentifier"],
  b: WorkspaceFolderInfo["repoIdentifier"],
): boolean {
  if (a === null || b === null) return a === b;
  return a.owner === b.owner && a.repo === b.repo;
}

function landingDraftWorkspaceToDesktopValue(
  workspace: LandingDraftWorkspaceSnapshot,
): DesktopJsonValue {
  const normalizedWorkspace = normalizeLandingDraftWorkspace(workspace);
  return {
    folders: [...normalizedWorkspace.folders],
    folderInfoByPath: workspaceFolderInfoByPathToDesktopValue(
      normalizedWorkspace.folderInfoByPath,
    ),
    primaryPath: normalizedWorkspace.primaryPath,
  };
}

function workspaceFolderInfoByPathToDesktopValue(
  infoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
): DesktopJsonValue {
  return Object.fromEntries(
    Object.entries(infoByPath).map(([path, info]) => [
      path,
      {
        path: info.path,
        name: info.name,
        hostId: info.hostId,
        repoIdentifier:
          info.repoIdentifier === null
            ? null
            : {
                owner: info.repoIdentifier.owner,
                repo: info.repoIdentifier.repo,
              },
      },
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Strip pending base64 image nodes (and any `attachmentGroup` left empty) from
// content at the two SERIALIZATION seams [Mechanism A] — the persist
// `partialize` and `projectLandingDraftForDesktop` — NOT in `setDraftContent`
// (in-memory draft content is canonical and may carry a paste's still-pending
// b64 node). Hash-only image nodes (whose bytes are durably stored) are kept; a
// still-pending b64 node is dropped from the serialized form until its background
// job flips it to a hash and the next serialization captures the converted node.
function stripBase64ImageNodes(content: JsonContent): JsonContent {
  return stripBase64ImageNode(content) ?? EMPTY_LANDING_DRAFT_CONTENT;
}

function stripBase64ImageNode(node: JsonContent): JsonContent | null {
  if (node.type === "imageAttachment") {
    return typeof node.attrs?.b64content === "string" ? null : node;
  }
  const children = node.content;
  if (children === undefined) return node;
  const nextChildren = children.flatMap((child) => {
    const stripped = stripBase64ImageNode(child);
    return stripped === null ? [] : [stripped];
  });
  if (node.type === "attachmentGroup" && nextChildren.length === 0) return null;
  return { ...node, content: nextChildren };
}

function sameDraftSelection(
  a: DraftSelection | null,
  b: DraftSelection | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}

export function freshLandingMirrorState(): Pick<
  LandingDraftTab,
  | "adoption"
  | "hostRevision"
  | "generation"
  | "syncedGeneration"
  | "ownerHostId"
  | "origin"
  | "publication"
  | "confirmedHostBlobHashes"
  | "closed"
> {
  return {
    adoption: UNADOPTED_LANDING_DRAFT,
    hostRevision: 0,
    generation: 0,
    syncedGeneration: 0,
    ownerHostId: null,
    origin: null,
    publication: null,
    confirmedHostBlobHashes: [],
    closed: false,
  };
}

function parseLandingMirrorFields(
  raw: Record<string, unknown>,
): Pick<
  LandingDraftTab,
  | "adoption"
  | "hostRevision"
  | "generation"
  | "syncedGeneration"
  | "ownerHostId"
  | "origin"
  | "publication"
  | "confirmedHostBlobHashes"
> {
  return {
    adoption: parseLandingAdoption(raw.adoption),
    hostRevision: nonNegativeNumber(raw.hostRevision),
    generation: 1,
    syncedGeneration: 0,
    ownerHostId: parseNullableId(raw.ownerHostId),
    origin: parseDraftOrigin(raw.origin),
    publication: parseDraftPublication(raw.publication),
    confirmedHostBlobHashes: parseConfirmedHashes(raw.confirmedHostBlobHashes),
  };
}

function parseLandingAdoption(value: unknown): LandingDraftAdoption {
  if (!isRecord(value) || value.state !== "adopted") {
    return UNADOPTED_LANDING_DRAFT;
  }
  if (typeof value.hostId !== "string" || value.hostId.length === 0) {
    return UNADOPTED_LANDING_DRAFT;
  }
  return { state: "adopted", hostId: value.hostId };
}

function mirrorFieldsFromExisting(
  id: string,
): Pick<
  LandingDraftTab,
  | "adoption"
  | "hostRevision"
  | "generation"
  | "syncedGeneration"
  | "ownerHostId"
  | "origin"
  | "publication"
  | "confirmedHostBlobHashes"
> {
  const existing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === id);
  if (existing === undefined) return freshLandingMirrorState();
  return {
    adoption: existing.adoption,
    hostRevision: existing.hostRevision,
    generation: existing.generation,
    syncedGeneration: existing.syncedGeneration,
    ownerHostId: existing.ownerHostId,
    origin: existing.origin,
    publication: existing.publication,
    confirmedHostBlobHashes: existing.confirmedHostBlobHashes,
  };
}

function parseNullableId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseDraftOrigin(value: unknown): "own" | "replica" | null {
  return value === "own" || value === "replica" ? value : null;
}

function parseDraftPublication(value: unknown): DraftPublication | null {
  if (!isRecord(value)) return null;
  if (
    value.status !== "unpublished" &&
    value.status !== "current" &&
    value.status !== "behind" &&
    value.status !== "unknown"
  ) {
    return null;
  }
  const lastPublishedAt =
    value.lastPublishedAt === null
      ? null
      : nonNegativeNumber(value.lastPublishedAt);
  const publishedRevision =
    value.publishedRevision === null
      ? null
      : nonNegativeNumber(value.publishedRevision);
  return {
    status: value.status,
    lastPublishedAt:
      value.lastPublishedAt === null ||
      typeof value.lastPublishedAt === "number"
        ? lastPublishedAt
        : null,
    publishedRevision:
      value.publishedRevision === null ||
      typeof value.publishedRevision === "number"
        ? publishedRevision
        : null,
    halted: null,
  };
}

function parseConfirmedHashes(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && SHA256_HEX.test(entry),
  );
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function landingDraftIsDirty(draftId: string): boolean {
  const draft = useLandingDraftStore
    .getState()
    .drafts.find((entry) => entry.id === draftId);
  if (draft === undefined) return false;
  return draft.generation > draft.syncedGeneration;
}

export function landingDraftRememberSynced(
  draftId: string,
  hostRevision: number,
  collectedGeneration: number,
): void {
  useLandingDraftStore.setState((state) => ({
    drafts: state.drafts.map((draft) => {
      if (draft.id !== draftId) return draft;
      return {
        ...draft,
        hostRevision,
        syncedGeneration:
          collectedGeneration >= draft.generation
            ? draft.generation
            : draft.syncedGeneration,
      };
    }),
  }));
}

export function adoptLandingDraft(draftId: string, hostId: string): void {
  useLandingDraftStore.setState((state) => ({
    drafts: state.drafts.map((draft) =>
      draft.id === draftId
        ? { ...draft, adoption: { state: "adopted", hostId } }
        : draft,
    ),
  }));
}

export function applyLandingHostDocument(
  document: DraftDocument,
  content: JsonContent,
): void {
  if (document.kind !== "landing") return;
  const existing = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === document.draftId);
  if (
    existing !== undefined &&
    existing.generation > existing.syncedGeneration
  ) {
    adoptLandingDraft(document.draftId, document.adoption.hostId);
    landingDraftRememberSynced(
      document.draftId,
      document.revision,
      existing.syncedGeneration,
    );
    return;
  }
  const next: LandingDraftTab = {
    id: document.draftId,
    content,
    selection: document.portable.selection,
    lastTouchedAt: document.lastTouchedAt,
    settings: document.portable.runSettings,
    composerMode: document.portable.composerMode,
    workspace:
      document.workspace === null
        ? emptyLandingDraftWorkspaceSnapshot()
        : document.workspace,
    adoption: { state: "adopted", hostId: document.adoption.hostId },
    hostRevision: document.revision,
    generation: existing?.generation ?? 0,
    syncedGeneration: existing?.generation ?? 0,
    ownerHostId: document.ownerHostId,
    origin: document.origin,
    publication: document.publication,
    confirmedHostBlobHashes: existing?.confirmedHostBlobHashes ?? [],
    closed: document.portable.closed,
  };
  useLandingDraftStore.setState((state) => {
    const without = state.drafts.filter((draft) => draft.id !== next.id);
    const drafts = evictAdoptedLandingMirrors([...without, next]);
    const activeDraftId =
      next.closed && state.activeDraftId === next.id
        ? null
        : state.activeDraftId;
    return { drafts, activeDraftId };
  });
}

export function applyLandingHostDelete(draftId: string): void {
  useLandingDraftStore.getState().deleteDraft(draftId);
}

export function collectLandingDirtyWrites(hostId: string): ReadonlyArray<{
  readonly draft: LandingDraftTab;
}> {
  return useLandingDraftStore
    .getState()
    .drafts.filter((draft) => {
      if (draft.generation <= draft.syncedGeneration) return false;
      if (draft.adoption.state === "unadopted") return false;
      return draft.adoption.hostId === hostId;
    })
    .map((draft) => ({ draft }));
}

export function collectUnadoptedLandingDrafts(): ReadonlyArray<LandingDraftTab> {
  return useLandingDraftStore
    .getState()
    .drafts.filter(
      (draft) =>
        draft.adoption.state === "unadopted" &&
        draft.generation > draft.syncedGeneration,
    );
}

export function dropLandingAbsentFromList(
  hostId: string,
  listedIds: ReadonlySet<string>,
): void {
  const drafts = useLandingDraftStore.getState().drafts;
  for (const draft of drafts) {
    if (draft.adoption.state !== "adopted") continue;
    if (draft.adoption.hostId !== hostId) continue;
    if (draft.generation > draft.syncedGeneration) continue;
    if (listedIds.has(draft.id)) continue;
    useLandingDraftStore.getState().dropLocalMirror(draft.id);
  }
}

/**
 * Pin the local mirror while any image hash is not yet confirmed on the
 * host. Once every hash has been `putBlob`/`readBlob`-acked, the row is
 * evictable again — the host is now the byte home.
 */
function landingDraftPinsLocalImageBytes(draft: LandingDraftTab): boolean {
  const confirmed = new Set(draft.confirmedHostBlobHashes);
  for (const atom of collectImageAtoms(draft.content)) {
    if (atom.hash === null || !SHA256_HEX.test(atom.hash)) continue;
    if (!confirmed.has(atom.hash)) return true;
  }
  return false;
}

export function rememberLandingBlobsOnHost(
  draftId: string,
  hashes: ReadonlyArray<string>,
): void {
  if (hashes.length === 0) return;
  useLandingDraftStore.setState((state) => ({
    drafts: state.drafts.map((draft) => {
      if (draft.id !== draftId) return draft;
      const next = new Set(draft.confirmedHostBlobHashes);
      for (const hash of hashes) next.add(hash);
      return { ...draft, confirmedHostBlobHashes: [...next] };
    }),
  }));
}

function evictAdoptedLandingMirrors(
  drafts: ReadonlyArray<LandingDraftTab>,
): ReadonlyArray<LandingDraftTab> {
  const activeId = useLandingDraftStore.getState().activeDraftId;
  const adopted = drafts.filter(
    (draft) =>
      draft.adoption.state === "adopted" &&
      draft.id !== activeId &&
      draft.generation <= draft.syncedGeneration,
  );
  const overflow = adopted.length - MAX_LOCAL_ADOPTED_LANDING_MIRRORS;
  if (overflow <= 0) return drafts;
  const evictable = adopted.filter(
    (draft) => !landingDraftPinsLocalImageBytes(draft),
  );
  const evictIds = new Set(
    [...evictable]
      .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt)
      .slice(0, overflow)
      .map((draft) => draft.id),
  );
  return drafts.filter((draft) => !evictIds.has(draft.id));
}
