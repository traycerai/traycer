import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/schemas";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import {
  adoptDraftImageHandoff,
  draftImageHashes,
} from "@/lib/composer/landing-image-move";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { appLogger, describeLogError } from "@/lib/logger";
import { isMobileApp } from "@/lib/mobile-app";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import { readComposerHostIdSnapshot } from "@/lib/composer/composer-host-snapshot";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
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

/** In-flight "new epic" draft shown in the global tab strip. Multiple drafts may coexist. */
export interface LandingDraftTab {
  readonly id: string;
  /** Full editor JSON - the persisted source of truth for the draft. */
  readonly content: JsonContent;
  /** Cursor position (from/to), mirroring the in-epic composer draft. */
  readonly selection: DraftSelection | null;
  /** Bumped on every content/selection edit; drives LRU eviction (T5). */
  readonly lastTouchedAt: number;
  readonly settings: ChatRunSettings | null;
  readonly composerMode: ComposerMode;
  readonly workspace: LandingDraftWorkspaceSnapshot;
}

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
  createDraft: (settings: ChatRunSettings | null) => string;
  /**
   * Coordinator-only stable-id source creation (restore/sync, landing null-draft mount key
   * stability) - explicit ids always mint, on every shell.
   */
  createDraftWithId: (id: string, settings: ChatRunSettings | null) => string;
  /** Remove a draft by id. If it was the active draft, clears `activeDraftId`;
   *  strip-neighbor navigation in the close-flow handles where the user lands. */
  closeDraft: (id: string) => void;
  /** Set the active draft without creating a new one. No-op if id not found. */
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
   * Persists a caret move alone, bumping `lastTouchedAt` without touching or comparing `content` - a
   * selection-only echo must never re-serialize a (possibly multi-megabyte inline-image) document
   */
  setDraftSelection: (id: string, selection: DraftSelection | null) => void;
  /** Update the run settings of a specific draft. No-op when id not found. */
  setDraftSettings: (id: string, settings: ChatRunSettings) => void;
  /** Update the chat-vs-terminal starting point of a specific draft. */
  setDraftComposerMode: (id: string, mode: ComposerMode) => void;
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
/** Draft ids whose image-handoff adoption has been attempted this session. */
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
  // [B1] Empty-inbound clobber guard.
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
  // `true` - which would permanently suppress all outbound projections.
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
  // A draft MOVED here from another window arrives with hash-only content whose bytes live in the
  // SOURCE window's partition; the source staged them in a per-draft handoff DB before the move.
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
  // [B2] A non-empty authoritative snapshot confirms the landing roots are real, so the GC's
  // deleting sweep may run (reaping genuine orphans) without risking freshly-restored bytes.
  if (drafts.length > 0) markLandingDraftsAuthoritativeNonEmpty();
  // [C1] Desktop drafts arrive asynchronously over IPC, so the orphan sweep is
  // gated until they do: the FIRST projection means the draft set is now known.
  markLandingDraftsReady();
}

function readProjectedDrafts(
  snapshot: DesktopPerWindowSnapshot,
): ReadonlyArray<LandingDraftTab> {
  return snapshot.landingDrafts.flatMap((draft) => {
    // T6: the desktop payload now carries real rich content (hash-only image nodes, mentions, marks).
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
      },
    ];
  });
}

/** Accept only doc-shaped editor JSON as restorable content. */
function parseLandingDraftContent(value: DesktopJsonValue): JsonContent | null {
  return isLandingDraftDocContent(value) ? value : null;
}

function isLandingDraftDocContent(value: unknown): value is JsonContent {
  // Require `content` to be an array (or absent): a malformed `{ type: "doc", content: <non-array>
  // }` would otherwise narrow to JsonContent and throw when `plainTextFromNodes` walks it during
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
  return drafts.some((draft) => draft.id === activeDraftId)
    ? activeDraftId
    : null;
}

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
  return drafts.some((draft) => draft.id === value) ? value : null;
}

// Rehydration-safe composer-mode parse.
function parsePersistedComposerMode(value: unknown): ComposerMode {
  return typeof value === "string" && isComposerMode(value)
    ? value
    : DEFAULT_COMPOSER_MODE;
}

/**
 * Content-derived emptiness: no typed text AND no image atoms. An image-only
 * draft is real content - discarding or replacing it would drop the image.
 */
export function isLandingDraftEmpty(draft: LandingDraftTab): boolean {
  if (
    extractPlainTextFromComposerJSONContent(draft.content).trim().length > 0
  ) {
    return false;
  }
  return !containsImageAtoms(draft.content);
}

/**
 * Newest existing landing draft, for the installed mobile app's single stable composer: an id-less
 * "new draft" activation reuses this instead of minting (see `createDraft`).
 */
export function newestLandingDraftId(): string | null {
  return newestDraft(useLandingDraftStore.getState().drafts);
}

function newestDraft(drafts: ReadonlyArray<LandingDraftTab>): string | null {
  let newest: LandingDraftTab | null = null;
  for (const draft of drafts) {
    // >= so the LATER array entry wins a millisecond tie: drafts are append-ordered, and same-ms
    // timestamps are realistic (restore paths stamp several drafts in one tick).
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
        // The installed mobile app has ONE stable composer: its header has no tab strip, so a second draft
        // tab could never be closed.
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
        // Workspace and default settings belong to the same placement host,
        // including drafts created through the tab strip or a split pane.
        const hostId = readComposerHostIdSnapshot();
        const next: LandingDraftTab = {
          id,
          content: EMPTY_LANDING_DRAFT_CONTENT,
          selection: null,
          lastTouchedAt: Date.now(),
          settings: copyChatRunSettings(
            settings ??
              useComposerRunSettingsStore
                .getState()
                .getGlobalRunSettings(hostId),
          ),
          // Seed from the global last-used mode; the draft owns it from here.
          composerMode: useSettingsStore.getState().composerMode,
          workspace: readLandingDraftWorkspaceSnapshotForHost(hostId),
        };
        set((state) => ({
          drafts: [...uniqueLandingDrafts(state.drafts), next],
          activeDraftId: next.id,
        }));
        return next.id;
      },

      closeDraft: (id) => {
        const { drafts, activeDraftId } = get();
        const next = drafts.filter((d) => d.id !== id);
        if (next.length === drafts.length) return;
        // A close is the runtime cancellation boundary.
        draftRuntimeRegistry.close(id);
        const nextActive = activeDraftId === id ? null : activeDraftId;
        set({ drafts: next, activeDraftId: nextActive });
        // Closing a draft can orphan its image bytes - reclaim them (debounced).
        scheduleLandingImageReconcile();
      },

      setActiveDraft: (id) => {
        if (!get().drafts.some((d) => d.id === id)) return;
        set({ activeDraftId: id });
      },

      clearActiveDraft: () => {
        if (get().activeDraftId === null) return;
        set({ activeDraftId: null });
      },

      setDraftContent: (id, content, selection) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (!draft) return;
        // The in-memory draft content is CANONICAL: it is both the source the serializers read AND the
        // source `openDraft` re-seeds the keyed remount from, so it must keep a paste's still-pending b64
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
                }
              : d,
          ),
        }));
      },

      setDraftSelection: (id, selection) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (!draft) return;
        if (sameDraftSelection(draft.selection, selection)) return;
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id ? { ...d, selection, lastTouchedAt: Date.now() } : d,
          ),
        }));
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
              d.id === id ? { ...d, settings: { ...settings } } : d,
            ),
          };
        });
      },

      setDraftComposerMode: (id, mode) => {
        const draft = get().drafts.find((d) => d.id === id);
        if (!draft || draft.composerMode === mode) return;
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id ? { ...d, composerMode: mode } : d,
          ),
        }));
      },

      restoreDraftWorkspaceForHost: (id, hostId) => {
        set((state) =>
          updateDraftWorkspace(state, id, () =>
            readLandingDraftWorkspaceSnapshotForHost(hostId),
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
        return before.filter((path) => !afterSet.has(path));
      },

      removeDraftFolder: (id, folderPath) => {
        set((state) =>
          updateDraftWorkspace(state, id, (workspace) =>
            removeLandingDraftWorkspaceFolder(workspace, folderPath),
          ),
        );
      },

      setDraftWorkspacePrimary: (id, folderPath) => {
        set((state) =>
          updateDraftWorkspace(state, id, (workspace) =>
            setLandingDraftWorkspacePrimary(workspace, folderPath),
          ),
        );
      },
    }),
    {
      ...basePersistOptions(LANDING_DRAFT_PERSIST_KEY),
      storage: createJSONStorage(() => landingDraftStorage),
      // Serialization boundary [Mechanism A]: persisted landing drafts NEVER carry base64.
      partialize: (state) => ({
        drafts: state.drafts.map((draft) => ({
          ...draft,
          content: stripBase64ImageNodes(draft.content),
        })),
        activeDraftId: state.activeDraftId,
      }),
      // Sanitize the localStorage payload on rehydration the same way `readProjectedDrafts` sanitizes
      // the desktop projection, so a legacy tab (pre-`content` retype / pre-`workspace`) can't rehydrate
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

// Same reasoning as the registry wiring above: `landing-image-budget.ts` intentionally has no
// import back into this persisted source (it would close a store → gc → budget → store cycle), so
registerLandingDraftRootSource({
  drafts: () => useLandingDraftStore.getState().drafts,
});
/** Render-stable projection of the active draft for the landing-page shell (`HomePage`). */
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

// Project the current in-memory drafts to the desktop per-window store.
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
  };
}

/** Reproduce the editor JSON as a `DesktopJsonValue`. */
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
  // Drafts persisted before `composerMode` existed (or carrying an unknown value) adopt the user's
  // global last-used mode - the same seed a fresh draft gets in `createDraft`.
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

function readLandingDraftWorkspaceSnapshotForHost(
  hostId: string | null,
): LandingDraftWorkspaceSnapshot {
  const bucket = selectWorkspaceFoldersBucket(
    useWorkspaceFoldersStore.getState(),
    hostId,
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
      d.id === id ? { ...d, workspace: nextWorkspace } : d,
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
    // Deterministic fallback to the first remaining folder when the removed folder WAS the explicit
    // primary; `resolvePrimaryPath` also covers the "no folders left" case (`null`).
    primaryPath: resolvePrimaryPath(nextFolders, workspace.primaryPath),
  };
}

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

// Strip pending base64 image nodes (and any `attachmentGroup` left empty) from content at the two
// SERIALIZATION seams [Mechanism A] - the persist `partialize` and `projectLandingDraftForDesktop`
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
