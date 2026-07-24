/**
 * Round-5 landing paste lifecycle seams.
 *
 * Drives the REAL LandingComposer + REAL landing-composer-store + REAL
 * landing-draft-store through the HomePage keyed remount boundary
 * (`key={activeDraftId}`). Fakes only idb-keyval timing (putImage durable
 * write). Does NOT re-implement ingest on a bare Editor — that is exactly
 * why round 4 missed the store/remount defect.
 */
import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ComponentProps, ReactElement } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildComposerClipboardHtml,
  composerClipboardPlainText,
} from "@/lib/composer/composer-clipboard";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  deleteImage,
  imageHashKeys,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import {
  flushPendingLandingDraftContent,
  useLandingComposerStore,
} from "@/stores/composer/landing-composer-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  LANDING_DRAFT_PERSIST_KEY,
  setLandingDraftDesktopProjectionBridge,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { DesktopPerWindowStatePatch } from "@/lib/windows/types";
import * as idb from "idb-keyval";

const mocks = vi.hoisted(() => ({
  reportableErrorToast: vi.fn(),
  scheduleLandingImageReconcile: vi.fn(() => undefined),
  actualScheduleLandingImageReconcile: null as null | (() => void),
  actualReconcile: null as null | (() => Promise<void>),
  rewriteResults: [] as boolean[],
  capturedHandle: {
    current: null as ComposerPromptEditorHandle | null,
  },
}));

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: mocks.reportableErrorToast,
}));

vi.mock("@/lib/composer/landing-image-gc", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/composer/landing-image-gc")>();
  mocks.actualScheduleLandingImageReconcile =
    actual.scheduleLandingImageReconcile;
  mocks.actualReconcile = actual.reconcile;
  mocks.scheduleLandingImageReconcile.mockImplementation(() => undefined);
  return {
    ...actual,
    scheduleLandingImageReconcile: mocks.scheduleLandingImageReconcile,
  };
});

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

/** Gate durable writes by content hash (not call order) so OOO completion is real. */
const setGates = vi.hoisted(
  () =>
    new Map<string, { release: () => void; reject: (error: Error) => void }>(),
);

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      const hash = typeof key === "string" ? key : String(key);
      return new Promise<void>((resolve, reject) => {
        setGates.set(hash, {
          release: () => {
            idbData.set(hash, value);
            setGates.delete(hash);
            resolve();
          },
          reject: (error: Error) => {
            setGates.delete(hash);
            reject(error);
          },
        });
      });
    }),
    del: vi.fn((key: string) => {
      idbData.delete(typeof key === "string" ? key : String(key));
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

// Capture the real editor handle so tests can assert rewrite return values and
// drive remove-by-id without re-implementing paste ingest on a bare Editor.
// Forward a wrapped handle to LandingComposer so rewrite return values are
// observed on the same object the production code calls.
vi.mock(
  "@/components/chat/composer/composer-prompt-editor",
  async (importActual) => {
    const React = await import("react");
    const actual =
      await importActual<
        typeof import("@/components/chat/composer/composer-prompt-editor")
      >();
    const wrapHandle = (
      instance: ComposerPromptEditorHandle,
    ): ComposerPromptEditorHandle => ({
      isReady: () => instance.isReady(),
      focus: () => instance.focus(),
      focusAtEnd: () => instance.focusAtEnd(),
      getJSON: () => instance.getJSON(),
      isEmpty: () => instance.isEmpty(),
      clear: () => instance.clear(),
      setContent: (content, selection) =>
        instance.setContent(content, selection),
      insertImageAttachments: (attrs) => instance.insertImageAttachments(attrs),
      beginPathInsertion: () => instance.beginPathInsertion(),
      removeImageAttachmentById: (id) => instance.removeImageAttachmentById(id),
      rewriteImageAttachmentHashById: (id, hash) => {
        const result = instance.rewriteImageAttachmentHashById(id, hash);
        mocks.rewriteResults.push(result);
        return result;
      },
      insertDictatedText: (text) => instance.insertDictatedText(text),
      dismissActiveSuggestion: () => instance.dismissActiveSuggestion(),
    });
    const Forwarded = React.forwardRef<
      ComposerPromptEditorHandle,
      ComponentProps<typeof actual.ComposerPromptEditor>
    >((props, ref) => {
      const setRef = (instance: ComposerPromptEditorHandle | null): void => {
        const next = instance === null ? null : wrapHandle(instance);
        mocks.capturedHandle.current = next;
        if (typeof ref === "function") {
          ref(next);
        } else if (ref) {
          ref.current = next;
        }
      };
      return React.createElement(actual.ComposerPromptEditor, {
        ...props,
        ref: setRef,
      });
    });
    Forwarded.displayName = "ComposerPromptEditorTestCapture";
    return {
      ...actual,
      ComposerPromptEditor: Forwarded,
    };
  },
);

// Peripheral LandingComposer deps — NOT the stores under test, and NOT the
// editor / paste / draft write path.
vi.mock("@/components/home/hooks/use-composer-toolbar-store", () => {
  const toolbarStore = createStore(() => ({
    selection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
    selectedModel: {
      harnessId: "claude",
      slug: "claude-sonnet",
      label: "Sonnet",
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      defaultServiceTier: null,
      supportedServiceTiers: [],
      metadata: {},
    },
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
  }));
  return { useComposerToolbarStore: () => toolbarStore };
});

vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: () => ({
    submit: vi.fn(),
    selectTerminalAgent: vi.fn(),
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths: readonly string[]) =>
        Promise.resolve([...paths]),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => null,
}));

vi.mock(
  "@/components/chat/composer/use-profile-rate-limit-switch-prompt",
  () => ({
    useProfileRateLimitSwitchPrompt: () => ({
      kind: "hidden",
      dismiss: vi.fn(),
    }),
  }),
);

vi.mock(
  "@/hooks/providers/use-refresh-providers-list-on-turn-default-host",
  () => ({
    useRefreshProvidersListOnTurnDefaultHost: () => undefined,
  }),
);

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({
    folders: [],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({
    status: "ready",
    disabledHint: null,
  }),
  workspaceComposerCanStart: () => true,
}));

vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));

vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useLandingComposerMentionRoots: () => [],
}));

vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: null,
  }),
}));

vi.mock("@/hooks/epic/use-epic-create-mutation", () => ({
  useEpicCreate: () => ({ isPending: false }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({ isPending: false }),
}));

// Keep the toolbar thin so catalog/query noise does not obscure attachmentPending.
vi.mock("@/components/home/toolbar/composer-toolbar", () => ({
  ComposerToolbar: (props: {
    readonly attachmentPending: boolean;
    readonly canSubmit: boolean;
  }) => (
    <div data-testid="lifecycle-toolbar">
      <span data-testid="lifecycle-attachment-pending">
        {String(props.attachmentPending)}
      </span>
      <span data-testid="lifecycle-can-submit">{String(props.canSubmit)}</span>
    </div>
  ),
}));

vi.mock("@/components/home/composer/terminal-launch-panel", () => ({
  TerminalLaunchPanel: () => null,
}));

vi.mock("@/components/home/composer/composer-workspace-mode-row", () => ({
  ComposerWorkspaceRow: () => null,
}));

// Import AFTER mocks so LandingComposer sees the wrapped editor + idb gates.
import { LandingComposer } from "../landing-composer";

let urlCounter = 0;

beforeEach(async () => {
  URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
  URL.revokeObjectURL = vi.fn();
  // Reinstall working idb (prior cases may have left rejecting overrides).
  vi.mocked(idb.set).mockImplementation((key, value) => {
    const hash = idbStringKey(key);
    return new Promise<void>((resolve, reject) => {
      setGates.set(hash, {
        release: () => {
          idbData.set(hash, value);
          setGates.delete(hash);
          resolve();
        },
        reject: (error: Error) => {
          setGates.delete(hash);
          reject(error);
        },
      });
    });
  });
  vi.mocked(idb.get).mockImplementation((key) =>
    Promise.resolve(idbData.get(idbStringKey(key))),
  );
  vi.mocked(idb.del).mockImplementation((key) => {
    idbData.delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(idb.keys).mockImplementation(() =>
    Promise.resolve(Array.from(idbData.keys())),
  );
  for (const hash of await imageHashKeys()) {
    await deleteImage(hash);
    releaseSession(hash);
  }
  idbData.clear();
  setGates.clear();
  mocks.reportableErrorToast.mockClear();
  mocks.scheduleLandingImageReconcile.mockClear();
  mocks.scheduleLandingImageReconcile.mockImplementation(() => undefined);
  mocks.rewriteResults.length = 0;
  mocks.capturedHandle.current = null;
  window.localStorage.clear();
  setLandingDraftDesktopProjectionBridge(null);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useLandingComposerStore.getState().reset();
});

afterEach(() => {
  cleanup();
  flushPendingLandingDraftContent();
  setLandingDraftDesktopProjectionBridge(null);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useLandingComposerStore.getState().reset();
  vi.useRealTimers();
});

/**
 * HomePage keying: `<LandingComposer key={draftId} draftId={draftId}>`.
 * Subscribes to the REAL store's activeDraftId so createDraft flipping the
 * active id genuinely remounts the composer (and re-runs mount-time re-entry).
 */
function KeyedLandingComposerHarness(): ReactElement {
  const draftId = useLandingDraftStore((state) => state.activeDraftId);
  return (
    <LandingComposer
      key={draftId}
      draftId={draftId}
      initialSettings={null}
      workspaceControls={null}
    />
  );
}

describe("landing paste lifecycle (real stores + keyed LandingComposer)", () => {
  // Seam 1: null-bound paste → draft create → keyed remount → pending survives
  // → resolve write → hash-only in editor, draft store, and both serializers.
  it("null-bound mixed paste survives keyed remount and converges to hash-only everywhere", async () => {
    // localStorage is only written when NO desktop bridge is installed
    // (`setLandingDraftDesktopProjectionBridge` disables local persistence).
    // Exercise localStorage first, then the desktop seam, then settle.
    const bytes1 = bytesOf([1, 1, 1]);
    const bytes2 = bytesOf([2, 2, 2]);
    const hash1 = await sha256Hex(bytes1);
    const hash2 = await sha256Hex(bytes2);

    render(<KeyedLandingComposerHarness />);
    await waitForEditorReady();

    pasteComposerContent(
      mixedContent(bytesToBase64(bytes1), bytesToBase64(bytes2)),
    );

    // Synchronous draft creation for image-bearing null-bound edit.
    await waitFor(() => {
      expect(useLandingDraftStore.getState().activeDraftId).not.toBeNull();
    });
    const draftId = useLandingDraftStore.getState().activeDraftId;
    expect(draftId).not.toBeNull();

    // Keyed remount re-seeds from the canonical in-memory draft (b64 kept).
    await waitFor(() => {
      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === draftId);
      const atoms = collectImageAtoms(draft?.content ?? emptyDoc());
      expect(atoms).toHaveLength(2);
      expect(atoms.every((atom) => atom.b64content !== null)).toBe(true);
      expect(atoms.every((atom) => atom.hash === null)).toBe(true);
    });

    // Seam 2a (localStorage partialize while pending): drops still-pending nodes.
    await waitFor(() => {
      const raw = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
      expect(raw).not.toBeNull();
      expect(serializedHasStringB64(raw)).toBe(false);
      // Pending-only paste: both images stripped → no imageAttachment remains.
      expect(raw).not.toContain("imageAttachment");
    });

    // Seam 2b (desktop projection while pending): same strip.
    // Installing the bridge disables further localStorage writes (desktop mode).
    const desktopPatches: DesktopPerWindowStatePatch[] = [];
    setLandingDraftDesktopProjectionBridge({
      update: (patch) => {
        desktopPatches.push(patch);
        return Promise.resolve();
      },
      flush: () => Promise.resolve(),
      dispose: () => undefined,
    });
    // Touch the draft so the store subscription projects outbound.
    const pendingContent = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === draftId)?.content;
    expect(pendingContent).toBeDefined();
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId ?? "", pendingContent ?? emptyDoc(), null);
    await waitFor(() => {
      expect(desktopPatches.length).toBeGreaterThan(0);
    });
    const latestDesktop = desktopPatches.at(-1)?.landingDrafts?.[0]?.content;
    expect(serializedHasStringB64(JSON.stringify(latestDesktop ?? {}))).toBe(
      false,
    );
    expect(JSON.stringify(latestDesktop ?? {})).not.toContain(
      "imageAttachment",
    );

    // Submit stays gated while ingest is in flight (across the remount).
    await waitFor(() => {
      expect(
        screen.getByTestId("lifecycle-attachment-pending").textContent,
      ).toBe("true");
    });

    // Release durable writes (order reversed) and wait for rewrite.
    await waitFor(() => {
      expect(setGates.has(hash1)).toBe(true);
      expect(setGates.has(hash2)).toBe(true);
    });
    setGates.get(hash2)?.release();
    setGates.get(hash1)?.release();

    await waitFor(() => {
      const atoms = collectImageAtoms(
        useLandingComposerStore.getState().currentContent,
      );
      expect(atoms.map((atom) => atom.hash)).toEqual([hash1, hash2]);
      expect(atoms.every((atom) => atom.b64content === null)).toBe(true);
    });

    // Draft store (after debounce flush) holds hash-only.
    await act(async () => {
      flushPendingLandingDraftContent();
      await Promise.resolve();
    });
    await waitFor(() => {
      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === draftId);
      const atoms = collectImageAtoms(draft?.content ?? emptyDoc());
      expect(atoms.map((atom) => atom.hash)).toEqual([hash1, hash2]);
      expect(atoms.every((atom) => atom.b64content === null)).toBe(true);
    });

    // Desktop projection after settle is hash-only (no string b64 payload).
    await waitFor(() => {
      const projected = desktopPatches.at(-1)?.landingDrafts?.[0]?.content;
      const text = JSON.stringify(projected ?? {});
      expect(text).toContain(hash1);
      expect(text).toContain(hash2);
      expect(serializedHasStringB64(text)).toBe(false);
    });

    // localStorage after settle: re-enable local persistence (drop bridge) and
    // force one write so the partialize path records the hash-only draft.
    setLandingDraftDesktopProjectionBridge(null);
    const settledContent = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === draftId)?.content;
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId ?? "", settledContent ?? emptyDoc(), null);
    await waitFor(() => {
      const raw = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
      expect(raw).toContain(hash1);
      expect(raw).toContain(hash2);
      expect(serializedHasStringB64(raw)).toBe(false);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("lifecycle-attachment-pending").textContent,
      ).toBe("false");
    });

    // Editor handle converges too (read-back path through the real remount).
    const handle = mocks.capturedHandle.current;
    expect(handle).not.toBeNull();
    const editorAtoms = collectImageAtoms(handle?.getJSON() ?? emptyDoc());
    expect(editorAtoms.map((atom) => atom.hash)).toEqual([hash1, hash2]);
  });

  it("null-bound image-only paste creates a draft, remounts, and converges hash-only", async () => {
    const bytes = bytesOf([9, 9, 9]);
    const hash = await sha256Hex(bytes);

    render(<KeyedLandingComposerHarness />);
    await waitForEditorReady();

    pasteComposerContent(imageOnlyContent(bytesToBase64(bytes), "only.png"));

    await waitFor(() => {
      expect(useLandingDraftStore.getState().activeDraftId).not.toBeNull();
    });
    const draftId = useLandingDraftStore.getState().activeDraftId;

    await waitFor(() => {
      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === draftId);
      const atoms = collectImageAtoms(draft?.content ?? emptyDoc());
      expect(atoms).toHaveLength(1);
      expect(atoms[0]?.b64content).not.toBeNull();
      expect(atoms[0]?.hash).toBeNull();
    });

    await waitFor(() => expect(setGates.has(hash)).toBe(true));
    setGates.get(hash)?.release();

    await waitFor(() => {
      const atoms = collectImageAtoms(
        useLandingComposerStore.getState().currentContent,
      );
      expect(atoms).toHaveLength(1);
      expect(atoms[0]?.hash).toBe(hash);
      expect(atoms[0]?.b64content).toBeNull();
    });
  });

  // Seam 2 standalone (also covered above while pending): partialize + desktop.
  it("serialization seams strip pending b64 while the in-memory draft keeps it", async () => {
    const desktopPatches: DesktopPerWindowStatePatch[] = [];
    setLandingDraftDesktopProjectionBridge({
      update: (patch) => {
        desktopPatches.push(patch);
        return Promise.resolve();
      },
      flush: () => Promise.resolve(),
      dispose: () => undefined,
    });

    const bytes = bytesOf([3, 3, 3]);
    render(<KeyedLandingComposerHarness />);
    await waitForEditorReady();
    pasteComposerContent(imageOnlyContent(bytesToBase64(bytes), "pending.png"));

    await waitFor(() => {
      expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
      const atoms = collectImageAtoms(
        useLandingDraftStore.getState().drafts[0]?.content ?? emptyDoc(),
      );
      expect(atoms[0]?.b64content).not.toBeNull();
    });

    // In-memory keeps a real string b64 payload.
    const inMemoryAtoms = collectImageAtoms(
      useLandingDraftStore.getState().drafts[0]?.content ?? emptyDoc(),
    );
    expect(inMemoryAtoms[0]?.b64content).not.toBeNull();

    // localStorage partialize strips the pending node entirely.
    await waitFor(() => {
      const raw = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
      expect(raw).not.toBeNull();
      expect(serializedHasStringB64(raw)).toBe(false);
      expect(raw).not.toContain("imageAttachment");
    });

    // Desktop projection strips the pending node entirely.
    const outbound = desktopPatches.at(-1)?.landingDrafts?.[0]?.content;
    expect(serializedHasStringB64(JSON.stringify(outbound ?? {}))).toBe(false);
    expect(JSON.stringify(outbound ?? {})).not.toContain("imageAttachment");
  });

  // Seam 3: unmount mid-ingest → remount restarts job, stays gated, converges.
  it("unmount mid-ingest remount restarts ingest, gates submit, and converges", async () => {
    const bytes = bytesOf([4, 4, 4]);
    const hash = await sha256Hex(bytes);

    const view = render(<KeyedLandingComposerHarness />);
    await waitForEditorReady();
    pasteComposerContent(imageOnlyContent(bytesToBase64(bytes), "mid.png"));

    await waitFor(() => {
      expect(useLandingDraftStore.getState().activeDraftId).not.toBeNull();
    });
    const draftId = useLandingDraftStore.getState().activeDraftId;

    // Hold the durable write open so remount must start a NEW job.
    await waitFor(() => expect(setGates.has(hash)).toBe(true));
    expect(screen.getByTestId("lifecycle-attachment-pending").textContent).toBe(
      "true",
    );

    // Full unmount of the keyed composer (navigate-away).
    view.unmount();
    // Aborting the first mount schedules reclaim; keep that as a spy only so
    // we don't race a deleting sweep against the still-pending remount.
    mocks.scheduleLandingImageReconcile.mockClear();

    // Remount on the same draft id (navigate-back) — real stores still hold b64.
    render(
      <LandingComposer
        key={draftId}
        draftId={draftId}
        initialSettings={null}
        workspaceControls={null}
      />,
    );
    await waitForEditorReady();

    await waitFor(() => {
      const atoms = collectImageAtoms(
        useLandingComposerStore.getState().currentContent,
      );
      expect(atoms).toHaveLength(1);
      expect(atoms[0]?.b64content).not.toBeNull();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("lifecycle-attachment-pending").textContent,
      ).toBe("true");
    });

    // Remount re-entry started a new putImage flight; release it.
    await waitFor(() => expect(setGates.has(hash)).toBe(true));
    setGates.get(hash)?.release();

    await waitFor(() => {
      const atoms = collectImageAtoms(
        useLandingComposerStore.getState().currentContent,
      );
      expect(atoms[0]?.hash).toBe(hash);
      expect(atoms[0]?.b64content).toBeNull();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("lifecycle-attachment-pending").textContent,
      ).toBe("false");
    });
  });

  // Seam 4: delete-before-write → rewrite false, reconcile, zero unrooted keys.
  it("delete-before-write returns rewrite false, schedules reconcile, and sweeps IDB", async () => {
    // Call through to the real scheduler so the sweep actually reclaims.
    mocks.scheduleLandingImageReconcile.mockImplementation(() => {
      mocks.actualScheduleLandingImageReconcile?.();
    });

    const bytes = bytesOf([5, 5, 5]);
    const hash = await sha256Hex(bytes);

    render(<KeyedLandingComposerHarness />);
    await waitForEditorReady();
    pasteComposerContent(imageOnlyContent(bytesToBase64(bytes), "delete.png"));

    await waitFor(() => {
      expect(useLandingDraftStore.getState().activeDraftId).not.toBeNull();
    });
    await waitFor(() => expect(setGates.has(hash)).toBe(true));

    const pendingAtoms = collectImageAtoms(
      useLandingComposerStore.getState().currentContent,
    );
    expect(pendingAtoms).toHaveLength(1);
    const pendingId = pendingAtoms[0].id;

    mocks.rewriteResults.length = 0;
    mocks.scheduleLandingImageReconcile.mockClear();
    // Re-arm call-through after clear.
    mocks.scheduleLandingImageReconcile.mockImplementation(() => {
      mocks.actualScheduleLandingImageReconcile?.();
    });

    // Remove the pending node before the durable write settles.
    const handle = mocks.capturedHandle.current;
    expect(handle).not.toBeNull();
    handle?.removeImageAttachmentById(pendingId);

    await waitFor(() => {
      expect(
        collectImageAtoms(useLandingComposerStore.getState().currentContent),
      ).toHaveLength(0);
    });

    setGates.get(hash)?.release();

    await waitFor(() => {
      expect(mocks.rewriteResults).toContain(false);
    });
    await waitFor(() => {
      expect(mocks.scheduleLandingImageReconcile).toHaveBeenCalled();
    });

    // Session release + follow-up IDB delete (debounced reconcile chain).
    await waitFor(
      async () => {
        // Force any pending debounced reconcile to run under real timers.
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
        });
        // A second pass clears keys that were session-protected on the first.
        await mocks.actualReconcile?.();
        await mocks.actualReconcile?.();
        const keys = await imageHashKeys();
        expect(keys).toEqual([]);
      },
      { timeout: 3000 },
    );
  });

  // Seam 5: budget rejection → exactly one toast with the budget copy.
  it("budget rejection toasts exactly once with the budget copy (no double toast)", async () => {
    // Fill the partition budget with a large hash-only atom on an inactive draft
    // while activeDraftId stays null (unattributed paste cannot evict).
    const bigSize = 64 * 1024 * 1024;
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "budget-filler",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "imageAttachment",
                    attrs: {
                      id: "filler",
                      fileName: "filler.png",
                      hash: "a".repeat(64),
                      mimeType: "image/png",
                      size: bigSize,
                    },
                  },
                ],
              },
            ],
          },
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
        },
      ],
      activeDraftId: null,
    });

    render(<KeyedLandingComposerHarness />);
    await waitForEditorReady();

    const bytes = bytesOf([6, 6, 6]);
    pasteComposerContent(imageOnlyContent(bytesToBase64(bytes), "blocked.png"));

    await waitFor(() => {
      expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);
    });
    expect(mocks.reportableErrorToast).toHaveBeenCalledWith(
      "Couldn't add the image.",
      {
        description: "It would exceed this window's image storage budget.",
      },
      {
        title: "Could not add image",
        message: "The image storage budget was exceeded.",
        code: null,
        source: "Chat composer",
      },
    );
    // No pending image was admitted.
    expect(
      collectImageAtoms(useLandingComposerStore.getState().currentContent),
    ).toHaveLength(0);
    // Budget path must not also fire the generic corrupted/too-large toast.
    expect(mocks.reportableErrorToast).toHaveBeenCalledTimes(1);
  });

  // Seam 6: restart simulation — rehydrate from stripped serialized state;
  // the pending image is absent (accepted imperfection: process exit mid-ingest).
  it("restart from serialized stripped state drops the pending image (accepted imperfection)", async () => {
    const bytes = bytesOf([7, 7, 7]);

    render(<KeyedLandingComposerHarness />);
    await waitForEditorReady();
    pasteComposerContent(imageOnlyContent(bytesToBase64(bytes), "restart.png"));

    await waitFor(() => {
      expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
      expect(
        collectImageAtoms(
          useLandingDraftStore.getState().drafts[0]?.content ?? emptyDoc(),
        )[0]?.b64content,
      ).not.toBeNull();
    });

    // Capture the serialized (stripped) payload — process-exit durable form.
    await waitFor(() => {
      const raw = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
      expect(raw).not.toBeNull();
      expect(raw).not.toContain("b64content");
    });
    const serialized = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
    expect(serialized).not.toBeNull();

    // Simulate restart: wipe live stores, keep only the serialized form.
    cleanup();
    flushPendingLandingDraftContent();
    useLandingComposerStore.getState().reset();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    window.localStorage.setItem(LANDING_DRAFT_PERSIST_KEY, serialized ?? "{}");
    await useLandingDraftStore.persist.rehydrate();

    const rehydrated = useLandingDraftStore.getState().drafts;
    expect(rehydrated).toHaveLength(1);
    // Accepted imperfection: pending b64 was never in the serialized form, so
    // the image is gone after process restart mid-ingest.
    expect(
      collectImageAtoms(rehydrated[0]?.content ?? emptyDoc()),
    ).toHaveLength(0);
    expect(
      serializedHasStringB64(JSON.stringify(rehydrated[0]?.content ?? {})),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForEditorReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("composer-editor")).toBeTruthy();
    expect(mocks.capturedHandle.current?.isReady()).toBe(true);
  });
}

function pasteComposerContent(content: JsonContent): void {
  const html = buildComposerClipboardHtml(
    content,
    composerClipboardPlainText(content),
  );
  fireEvent.paste(screen.getByTestId("composer-editor"), {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/html"],
      getData: (type: string) => (type === "text/html" ? html : ""),
    },
  });
}

function mixedContent(b64a: string, b64b: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "A" },
          {
            type: "imageAttachment",
            attrs: {
              id: "src-1",
              fileName: "one.png",
              b64content: b64a,
              mimeType: "image/png",
              size: 3,
            },
          },
          { type: "text", text: "B" },
          {
            type: "imageAttachment",
            attrs: {
              id: "src-2",
              fileName: "two.png",
              b64content: b64b,
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
  };
}

function imageOnlyContent(b64: string, fileName: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: `src-${fileName}`,
              fileName,
              b64content: b64,
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
  };
}

function emptyDoc(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

/** True when any image atom carries a non-null string `b64content` payload. */
function serializedHasStringB64(serialized: string | null): boolean {
  if (serialized === null) return false;
  // Match only real base64 payloads, not the `"b64content":null` attr that a
  // hash-only node may still carry after rewrite.
  return /"b64content"\s*:\s*"[^"]+"/.test(serialized);
}

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
