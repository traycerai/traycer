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
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
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
import { EMPTY_LANDING_DRAFT_CONTENT } from "./landing-draft-content";
import {
  markLandingDraftsReady,
  scheduleLandingImageReconcile,
} from "@/lib/composer/landing-image-gc";

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
}

// Defined in the dependency-free leaf `./landing-draft-content` (so the store
// import cycle can't TDZ on it); re-exported here for existing importers.
export { EMPTY_LANDING_DRAFT_CONTENT };

export interface LandingDraftWorkspaceSnapshot {
  readonly folders: ReadonlyArray<string>;
  readonly folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>;
}

interface LandingDraftStoreState {
  readonly drafts: ReadonlyArray<LandingDraftTab>;
  readonly activeDraftId: string | null;
  /** Always creates a fresh draft, sets it as active, returns its id. */
  createDraft: (settings: ChatRunSettings | null) => string;
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
  /** Update the run settings of a specific draft. No-op when id not found. */
  setDraftSettings: (id: string, settings: ChatRunSettings) => void;
  /** Update the chat-vs-terminal starting point of a specific draft. */
  setDraftComposerMode: (id: string, mode: ComposerMode) => void;
  addDraftResolvedFolders: (
    id: string,
    folders: ReadonlyArray<WorkspaceFolderInfo>,
  ) => void;
  removeDraftFolder: (id: string, folderPath: string) => void;
}

export const LANDING_DRAFT_PERSIST_KEY = persistKey(STORE_KEYS.landingDraft);
const MAX_DRAFT_WORKSPACE_FOLDERS = 50;

let localPersistenceEnabled = true;
let desktopProjectionBridge: DesktopPerWindowProjectionBridge | null = null;
let applyingDesktopProjection = false;

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
  setLandingDraftLocalPersistenceEnabled(bridge === null);
}

export function applyLandingDraftDesktopProjection(
  snapshot: DesktopPerWindowSnapshot,
): void {
  const drafts = uniqueLandingDrafts(readProjectedDrafts(snapshot));
  const activeDraftId = readProjectedActiveDraftId(snapshot, drafts);
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
  return drafts.some((draft) => draft.id === activeDraftId)
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

// Rehydration-safe composer-mode parse. Unlike `parseComposerMode` (which seeds
// a missing value from the live settings store), this stays self-contained: the
// persist `merge` runs during synchronous module-init rehydration, so it must
// not reach into another store, and falls back to the static default.
function parsePersistedComposerMode(value: unknown): ComposerMode {
  return typeof value === "string" && isComposerMode(value)
    ? value
    : DEFAULT_COMPOSER_MODE;
}

export const useLandingDraftStore = create<LandingDraftStoreState>()(
  persist(
    (set, get) => ({
      drafts: [],
      activeDraftId: null,

      createDraft: (settings) => {
        const next: LandingDraftTab = {
          id: uuidv4(),
          content: EMPTY_LANDING_DRAFT_CONTENT,
          selection: null,
          lastTouchedAt: Date.now(),
          settings: copyChatRunSettings(settings),
          // Seed from the global last-used mode; the draft owns it from here.
          composerMode: useSettingsStore.getState().composerMode,
          workspace: readCurrentLandingDraftWorkspaceSnapshot(),
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
        const nextActive = activeDraftId === id ? null : activeDraftId;
        set({ drafts: next, activeDraftId: nextActive });
        // Closing a draft can orphan its image bytes — reclaim them (debounced).
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
        if (
          sameJsonContent(draft.content, content) &&
          sameDraftSelection(draft.selection, selection)
        ) {
          return;
        }
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === id
              ? { ...d, content, selection, lastTouchedAt: Date.now() }
              : d,
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

      addDraftResolvedFolders: (id, folders) => {
        set((state) =>
          updateDraftWorkspace(state, id, (workspace) =>
            mergeLandingDraftWorkspaceFolders(workspace, folders),
          ),
        );
      },

      removeDraftFolder: (id, folderPath) => {
        set((state) =>
          updateDraftWorkspace(state, id, (workspace) =>
            removeLandingDraftWorkspaceFolder(workspace, folderPath),
          ),
        );
      },
    }),
    {
      ...basePersistOptions(LANDING_DRAFT_PERSIST_KEY),
      storage: createJSONStorage(() => landingDraftStorage),
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
  return useLandingDraftStore(
    useShallow((state) => {
      const draft =
        state.drafts.find((d) => d.id === state.activeDraftId) ?? null;
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

useLandingDraftStore.subscribe((state) => {
  if (desktopProjectionBridge === null || applyingDesktopProjection) return;
  void desktopProjectionBridge.update({
    landingDrafts: state.drafts.map(projectLandingDraftForDesktop),
    activeLandingDraftId: state.activeDraftId,
  });
});

function projectLandingDraftForDesktop(
  draft: LandingDraftTab,
): DesktopPerWindowLandingDraft {
  return {
    id: draft.id,
    // T6: emit the real hash-only editor JSON (no base64), the cursor, and the
    // edit time. `content` is plain JSON already; the walker reproduces it as a
    // `DesktopJsonValue` without a cast (`JsonContent`'s `unknown`-valued attrs
    // are not structurally assignable to `DesktopJsonValue`).
    content: landingDraftContentToDesktopValue(draft.content),
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
  return normalizeLandingDraftWorkspace({
    folders: [...useWorkspaceFoldersStore.getState().folders],
    folderInfoByPath: copyWorkspaceFolderInfoByPath(
      useWorkspaceFoldersStore.getState().folderInfoByPath,
    ),
  });
}

export function emptyLandingDraftWorkspaceSnapshot(): LandingDraftWorkspaceSnapshot {
  return {
    folders: [],
    folderInfoByPath: {},
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
      !sameRepoIdentifier(existing.repoIdentifier, folder.repoIdentifier)
    ) {
      accumulator.folderInfoByPath[path] = {
        path,
        name: folder.name,
        repoIdentifier: copyRepoIdentifier(folder.repoIdentifier),
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
  return {
    ...workspace,
    folders: workspace.folders.filter((path) => path !== folderPath),
    folderInfoByPath: nextInfoByPath,
  };
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
  });
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
  return {
    path: value.path,
    name: value.name,
    repoIdentifier: parseRepoIdentifier(value.repoIdentifier),
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
  const folders =
    workspace.folders.length > MAX_DRAFT_WORKSPACE_FOLDERS
      ? workspace.folders.slice(
          workspace.folders.length - MAX_DRAFT_WORKSPACE_FOLDERS,
        )
      : workspace.folders;
  const folderSet = new Set(folders);
  return {
    ...workspace,
    folders,
    folderInfoByPath: filterWorkspaceFolderInfoToFolders(
      workspace.folderInfoByPath,
      folderSet,
    ),
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

// Value-based content equality (H2). Image nodes are hash-only, so the
// serialized content is cheap/bounded; a stable JSON serialization is enough to
// short-circuit identical desktop echoes without a deep structural walk.
function sameJsonContent(a: JsonContent, b: JsonContent): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameDraftSelection(
  a: DraftSelection | null,
  b: DraftSelection | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}
