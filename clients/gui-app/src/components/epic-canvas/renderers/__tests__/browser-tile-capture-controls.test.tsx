/**
 * `<BrowserTileCaptureControls />` (`../browser-tile-capture-controls.tsx`),
 * rendered through `<BrowserTileToolbar />` the way a real tile mounts it -
 * `captureTarget` is a prop on the toolbar, not on the controls directly.
 *
 * Mocked wholesale: the host-capability gate (`useHostSupportsMethod`), the
 * permission role, the four `use-epic-files` hooks (the three mutations drive
 * their `onSuccess` synchronously, the same shape a real `useMutation` result
 * exposes), tile navigation, the new-conversation-modal open store, and the
 * "attach to chat" draft seeder. `sonner` is mocked too rather than mounting
 * the real `<Toaster />` - the toast assertions only need the call arguments,
 * including rendering the `action` node standalone.
 *
 * NOT mocked: `@/lib/epic-files/file-events-store`, whose `recordEpicFileEvent`
 * drives the badge lifecycle for real (case 5) and D06's once-per-epic sharing
 * notice (case 7).
 */
import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import type { BrowserTileCaptureTarget } from "@/components/epic-canvas/renderers/browser-tile-capture-controls";
import { __resetCaptureSharingNoticeForTests } from "@/lib/epic-files/capture-sharing-notice";
import {
  PRIMARY_TILE_CHROME_CAPABILITIES,
  type TileChromeCapabilities,
  type TileController,
} from "@/components/epic-canvas/renderers/tile-controller";
import {
  __resetEpicFileEventsForTests,
  recordEpicFileEvent,
} from "@/lib/epic-files/file-events-store";
import type {
  CaptureTabScreenshotRequest,
  CaptureTabScreenshotResponse,
  StartTabRecordingRequest,
  StartTabRecordingResponse,
  StartTabRecordingRefusal,
  StopTabRecordingRequest,
} from "@traycer/protocol/host/epic/files";
import type { EpicFileEntry } from "@traycer/protocol/persistence/epic/files";
import type { EpicFileRecord } from "@/stores/epics/open-epic/types";

// ── Hoisted, controllable state ─────────────────────────────────────────────

const hostSupport = vi.hoisted(() => ({ supported: true }));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => hostSupport.supported,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useMaybeEpicPermissionRole: () => "owner" as const,
}));

interface CaptureMutateOptions {
  readonly onSuccess: (response: CaptureTabScreenshotResponse) => void;
}

const captureState = vi.hoisted(() => ({
  isPending: false,
  nextResponse: { saved: null } as CaptureTabScreenshotResponse,
  calls: [] as CaptureTabScreenshotRequest[],
  mutate: (
    variables: CaptureTabScreenshotRequest,
    options: CaptureMutateOptions,
  ) => {
    captureState.calls.push(variables);
    options.onSuccess(captureState.nextResponse);
  },
}));

interface StartRecordingMutateOptions {
  readonly onSuccess: (response: StartTabRecordingResponse) => void;
}

const startRecordingState = vi.hoisted(() => ({
  isPending: false,
  nextResponse: {
    ok: true,
    recordingId: "r1",
  } as StartTabRecordingResponse,
  calls: [] as StartTabRecordingRequest[],
  mutate: (
    variables: StartTabRecordingRequest,
    options: StartRecordingMutateOptions,
  ) => {
    startRecordingState.calls.push(variables);
    options.onSuccess(startRecordingState.nextResponse);
  },
}));

const stopRecordingState = vi.hoisted(() => ({
  isPending: false,
  calls: [] as StopTabRecordingRequest[],
  mutate: (variables: StopTabRecordingRequest) => {
    stopRecordingState.calls.push(variables);
  },
}));

const recordingClipState = vi.hoisted(() => ({
  value: null as EpicFileRecord | null,
}));

vi.mock("@/hooks/epic/use-epic-files", () => ({
  useEpicCaptureTabScreenshot: () => ({
    mutate: captureState.mutate,
    isPending: captureState.isPending,
  }),
  useEpicStartTabRecording: () => ({
    mutate: startRecordingState.mutate,
    isPending: startRecordingState.isPending,
  }),
  useEpicStopTabRecording: () => ({
    mutate: stopRecordingState.mutate,
    isPending: stopRecordingState.isPending,
  }),
  useEpicRecordingClip: () => recordingClipState.value,
}));

const openTile = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile }),
}));

const openModal = vi.hoisted(() => vi.fn());

vi.mock("@/stores/epics/new-conversation-modal-open-store", () => ({
  useNewConversationModalOpenStore: (
    selector: (state: { readonly open: typeof openModal }) => unknown,
  ) => selector({ open: openModal }),
}));

const appendEpicFileToNewConversationDraft = vi.hoisted(() => vi.fn());

vi.mock("@/components/chat/quote/append-epic-file-to-draft", () => ({
  appendEpicFileToNewConversationDraft,
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({}),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, warning: toastWarning },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

const DISABLED_CAPABILITIES: TileChromeCapabilities = {
  navigate: false,
  back: false,
  forward: false,
  reload: false,
  zoom: false,
  viewportPreset: false,
  devtools: false,
  find: false,
  siteInfo: false,
  annotate: false,
  capture: false,
  record: false,
};

const SCREENCAST_CAPABILITIES: TileChromeCapabilities = {
  ...DISABLED_CAPABILITIES,
  navigate: true,
  back: true,
  forward: true,
  reload: true,
  capture: true,
  record: true,
};

const TARGET: BrowserTileCaptureTarget = {
  epicId: "epic-1",
  hostId: "host-1",
  tabId: "tab-1",
  viewTabId: "view-tab-1",
};

function preventNavigate(): void {}

function makeController(capabilities: TileChromeCapabilities): TileController {
  return {
    capabilities,
    profile: "primary",
    url: "https://example.com",
    addressValue: "https://example.com",
    selectAddressOnFocus: false,
    setAddressInput: () => undefined,
    focusAddress: () => undefined,
    canGoBack: true,
    canGoForward: true,
    zoomPercent: 100,
    viewportPreset: "responsive",
    disabled: false,
    zoomLocked: false,
    annotation: null,
    onNavigate: preventNavigate,
    onAddressChange: () => undefined,
    onAddressFocusChange: () => undefined,
    onBack: () => undefined,
    onForward: () => undefined,
    onReload: () => undefined,
    onZoomOut: () => undefined,
    onZoomIn: () => undefined,
    onResetZoom: () => undefined,
    onViewportPresetChange: () => undefined,
    onOpenDevTools: () => undefined,
    onClearSite: () => undefined,
  };
}

function renderToolbar(
  capabilities: TileChromeCapabilities,
  captureTarget: BrowserTileCaptureTarget | null,
): void {
  render(
    <TooltipProvider>
      <BrowserTileToolbar
        controller={makeController(capabilities)}
        captureTarget={captureTarget}
        pictureInPicture={null}
        loading={false}
      />
    </TooltipProvider>,
  );
}

function makeRecordingClipRecord(
  status: string,
  recordingId: string,
): EpicFileRecord {
  const entry: EpicFileEntry = {
    v: 1,
    kind: "recording",
    current: {
      sha256: "a".repeat(64),
      byteLength: 1024,
      mediaType: "video/webm",
      createdAt: Date.now(),
      createdBy: "user-1",
      producer: { type: "user" },
    },
    versions: [],
    status,
    recordingId,
    derivedFrom: [],
    deletedAt: null,
  };
  return { path: "files/recordings/r1.webm", entry };
}

// ── Reset between tests ─────────────────────────────────────────────────

beforeEach(() => {
  hostSupport.supported = true;
  captureState.isPending = false;
  captureState.nextResponse = { saved: null };
  captureState.calls = [];
  startRecordingState.isPending = false;
  startRecordingState.nextResponse = { ok: true, recordingId: "r1" };
  startRecordingState.calls = [];
  stopRecordingState.isPending = false;
  stopRecordingState.calls = [];
  recordingClipState.value = null;
  openTile.mockClear();
  openModal.mockClear();
  appendEpicFileToNewConversationDraft.mockClear();
  toastSuccess.mockClear();
  toastWarning.mockClear();
  __resetEpicFileEventsForTests();
  __resetCaptureSharingNoticeForTests();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

// ── 1. Capability gating x both variants ────────────────────────────────

describe("<BrowserTileCaptureControls /> capability gating", () => {
  it.each([
    { name: "primary chrome", capabilities: PRIMARY_TILE_CHROME_CAPABILITIES },
    { name: "screencast chrome", capabilities: SCREENCAST_CAPABILITIES },
  ])("shows both buttons for $name", ({ capabilities }) => {
    renderToolbar(capabilities, TARGET);

    expect(
      screen.getByRole("button", { name: "Capture screenshot" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Record tab" })).not.toBeNull();
  });

  it("shows only the record button when capture is false", () => {
    renderToolbar(
      { ...PRIMARY_TILE_CHROME_CAPABILITIES, capture: false },
      TARGET,
    );

    expect(
      screen.queryByRole("button", { name: "Capture screenshot" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Record tab" })).not.toBeNull();
  });

  it("shows only the capture button when record is false", () => {
    renderToolbar(
      { ...PRIMARY_TILE_CHROME_CAPABILITIES, record: false },
      TARGET,
    );

    expect(
      screen.getByRole("button", { name: "Capture screenshot" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Record tab" })).toBeNull();
  });

  it("shows neither button when both capabilities are false", () => {
    renderToolbar(
      { ...PRIMARY_TILE_CHROME_CAPABILITIES, capture: false, record: false },
      TARGET,
    );

    expect(
      screen.queryByRole("button", { name: "Capture screenshot" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Record tab" })).toBeNull();
  });

  it("hides both buttons when captureTarget is null, even with both capabilities true", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, null);

    expect(
      screen.queryByRole("button", { name: "Capture screenshot" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Record tab" })).toBeNull();
  });

  it("hides both buttons for an unsupported host and issues no request", () => {
    hostSupport.supported = false;
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    expect(
      screen.queryByRole("button", { name: "Capture screenshot" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Record tab" })).toBeNull();
    expect(captureState.calls).toHaveLength(0);
    expect(startRecordingState.calls).toHaveLength(0);
  });
});

// ── 4. Refusal toast ─────────────────────────────────────────────────────

describe("<BrowserTileCaptureControls /> recording refusals", () => {
  it.each([
    {
      reason: "host-limit" as StartTabRecordingRefusal,
      copy: "This host is already running two recordings.",
    },
    {
      reason: "unsupported-runtime" as StartTabRecordingRefusal,
      copy: "This tab's browser can't be recorded.",
    },
  ])("toasts $reason and shows no badge", ({ reason, copy }) => {
    startRecordingState.nextResponse = { ok: false, reason };
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    fireEvent.click(screen.getByRole("button", { name: "Record tab" }));

    expect(toastWarning).toHaveBeenCalledExactlyOnceWith(
      "Couldn't start recording",
      { description: copy },
    );
    expect(screen.queryByTestId("browser-tile-recording-badge")).toBeNull();
  });
});

// ── 5. Badge lifecycle ────────────────────────────────────────────────────

describe("<BrowserTileCaptureControls /> recording badge lifecycle", () => {
  it("goes starting -> recording -> uploading -> saved as events and clip status land", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    fireEvent.click(screen.getByRole("button", { name: "Record tab" }));
    expect(
      screen.getByTestId("browser-tile-recording-badge").textContent,
    ).toContain("Starting recording");
    expect(
      screen.getByRole("button", { name: "Stop recording" }),
    ).not.toBeNull();

    act(() => {
      recordEpicFileEvent(TARGET.epicId, {
        kind: "recordingStarted",
        recordingId: "r1",
        tabId: TARGET.tabId,
        hasBinaryPayload: false,
      });
    });
    expect(
      screen.getByTestId("browser-tile-recording-badge").textContent,
    ).toContain("Recording");
    expect(
      screen.getByTestId("browser-tile-recording-badge").textContent,
    ).toContain("0:00");

    recordingClipState.value = makeRecordingClipRecord("pending", "r1");
    act(() => {
      recordEpicFileEvent(TARGET.epicId, {
        kind: "recordingEnded",
        recordingId: "r1",
        tabId: TARGET.tabId,
        outcome: "saved",
        hasBinaryPayload: false,
      });
    });
    expect(
      screen.getByTestId("browser-tile-recording-badge").textContent,
    ).toContain("Uploading");
  });

  it.each([
    { status: "available", label: "Saved" },
    { status: "local-only", label: "Kept on its device" },
    { status: "failed", label: "Upload failed" },
  ])("shows $label once the clip settles to $status", ({ status, label }) => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);
    fireEvent.click(screen.getByRole("button", { name: "Record tab" }));
    act(() => {
      recordEpicFileEvent(TARGET.epicId, {
        kind: "recordingStarted",
        recordingId: "r1",
        tabId: TARGET.tabId,
        hasBinaryPayload: false,
      });
    });

    recordingClipState.value = makeRecordingClipRecord(status, "r1");
    act(() => {
      recordEpicFileEvent(TARGET.epicId, {
        kind: "recordingEnded",
        recordingId: "r1",
        tabId: TARGET.tabId,
        outcome: "saved",
        hasBinaryPayload: false,
      });
    });

    expect(
      screen.getByTestId("browser-tile-recording-badge").textContent,
    ).toContain(label);
  });

  it("shows Nothing recorded for a discarded outcome", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);
    fireEvent.click(screen.getByRole("button", { name: "Record tab" }));
    act(() => {
      recordEpicFileEvent(TARGET.epicId, {
        kind: "recordingStarted",
        recordingId: "r1",
        tabId: TARGET.tabId,
        hasBinaryPayload: false,
      });
    });

    act(() => {
      recordEpicFileEvent(TARGET.epicId, {
        kind: "recordingEnded",
        recordingId: "r1",
        tabId: TARGET.tabId,
        outcome: "discarded",
        hasBinaryPayload: false,
      });
    });

    expect(
      screen.getByTestId("browser-tile-recording-badge").textContent,
    ).toContain("Nothing recorded");
  });

  it("ignores a recordingStarted frame for a different tab", () => {
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    act(() => {
      recordEpicFileEvent(TARGET.epicId, {
        kind: "recordingStarted",
        recordingId: "r-other",
        tabId: "some-other-tab",
        hasBinaryPayload: false,
      });
    });

    expect(screen.queryByTestId("browser-tile-recording-badge")).toBeNull();
  });
});

// ── 6. Save toast actions ─────────────────────────────────────────────────

describe("<BrowserTileCaptureControls /> screenshot save toast", () => {
  it("names the saved file and issues no toast when nothing was saved", () => {
    captureState.nextResponse = { saved: null };
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    fireEvent.click(screen.getByRole("button", { name: "Capture screenshot" }));

    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("attaches to chat and opens the tile from the toast actions", () => {
    const sha256 = "b".repeat(64);
    captureState.nextResponse = {
      saved: { path: "files/screenshots/shot.png", sha256 },
    };
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    fireEvent.click(screen.getByRole("button", { name: "Capture screenshot" }));

    expect(toastSuccess).toHaveBeenCalledOnce();
    const toastArgs = toastSuccess.mock.calls[0] as [
      string,
      { readonly action: ReactNode },
    ];
    expect(toastArgs[0]).toBe("Saved shot.png");
    const action = toastArgs[1].action;

    render(action);
    fireEvent.click(screen.getByRole("button", { name: "Attach to chat" }));
    expect(
      appendEpicFileToNewConversationDraft,
    ).toHaveBeenCalledExactlyOnceWith({
      epicId: TARGET.epicId,
      path: "files/screenshots/shot.png",
      image: true,
    });
    expect(openModal).toHaveBeenCalledExactlyOnceWith({
      epicId: TARGET.epicId,
      tabId: TARGET.viewTabId,
      placement: null,
      parentId: null,
      hostId: TARGET.hostId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openTile).toHaveBeenCalledOnce();
    const intent = openTile.mock.calls[0][0] as {
      readonly node: {
        readonly type: string;
        readonly path: string;
        readonly hostId: string;
      };
    };
    expect(intent.node.type).toBe("epic-file");
    expect(intent.node.path).toBe("files/screenshots/shot.png");
    expect(intent.node.hostId).toBe(TARGET.hostId);
  });
});

// ── 7. Collaborator-sharing copy once per epic (D06) ──────────────────────

describe("<BrowserTileCaptureControls /> collaborator-sharing notice (D06)", () => {
  const SHARING_COPY =
    "Files captured here are visible to everyone on this epic.";

  function capture(): void {
    fireEvent.click(screen.getByRole("button", { name: "Capture screenshot" }));
  }

  it("carries the sharing description on the first capture in an epic", () => {
    captureState.nextResponse = {
      saved: { path: "files/screenshots/a.png", sha256: "a".repeat(64) },
    };
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    capture();

    expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(
      "Saved a.png",
      expect.objectContaining({ description: SHARING_COPY }),
    );
  });

  it("does not repeat the notice on a second capture in the same epic", () => {
    captureState.nextResponse = {
      saved: { path: "files/screenshots/a.png", sha256: "a".repeat(64) },
    };
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);

    capture();
    captureState.nextResponse = {
      saved: { path: "files/screenshots/b.png", sha256: "b".repeat(64) },
    };
    capture();

    expect(toastSuccess).toHaveBeenCalledTimes(2);
    const secondCallArgs = toastSuccess.mock.calls[1] as [
      string,
      { readonly description: string | undefined },
    ];
    expect(secondCallArgs[1].description).toBeUndefined();
  });

  it("carries the notice again in a different epic", () => {
    captureState.nextResponse = {
      saved: { path: "files/screenshots/a.png", sha256: "a".repeat(64) },
    };
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, TARGET);
    capture();
    cleanup();

    captureState.nextResponse = {
      saved: { path: "files/screenshots/c.png", sha256: "c".repeat(64) },
    };
    renderToolbar(PRIMARY_TILE_CHROME_CAPABILITIES, {
      ...TARGET,
      epicId: "epic-2",
    });
    capture();

    expect(toastSuccess).toHaveBeenCalledTimes(2);
    const secondCallArgs = toastSuccess.mock.calls[1] as [
      string,
      { readonly description: string | undefined },
    ];
    expect(secondCallArgs[1].description).toBe(SHARING_COPY);
  });
});
