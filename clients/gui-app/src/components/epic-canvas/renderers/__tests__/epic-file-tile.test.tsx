/**
 * Renderer states for the `epic-file` tile (`../epic-file-tile.tsx`).
 *
 * The two seams that decide what's on screen - `useFileBytes` (byte-source.ts)
 * and `useEpicFileEntry` / the write mutations (`use-epic-files.ts`) - are
 * mocked wholesale, per the module-boundary contract described in that file's
 * own docs. Everything else (the header chrome, `resolveViewer`'s family
 * routing, the action buttons) runs for real.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  EpicFileEntry,
  EpicFileProducer,
} from "@traycer/protocol/persistence/epic/files";
import type {
  FileBytesState,
  FileBytesUnavailableReason,
} from "@/lib/files/byte-source";
import type { EpicFileTileRef } from "@/stores/epics/canvas/types";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";

// ── Controllable state, set per test ────────────────────────────────────────

interface RendererTestState {
  bytes: FileBytesState;
  entry: EpicFileEntry | null;
  role: "owner" | "editor" | "viewer";
  hostLabel: string | null;
  readonly restoreMutate: Mock;
  readonly deleteMutate: Mock;
  readonly openInBrowserMutate: Mock;
  restorePending: boolean;
  deletePending: boolean;
  openInBrowserPending: boolean;
  readonly openBrowserUrl: Mock;
}

const LOADING_BYTES: FileBytesState = {
  status: "loading",
  src: null,
  mediaType: null,
  delivery: null,
  reason: null,
  header: null,
  servedFromCache: false,
  message: null,
};

const state = vi.hoisted((): RendererTestState => ({
  bytes: {
    status: "loading",
    src: null,
    mediaType: null,
    delivery: null,
    reason: null,
    header: null,
    servedFromCache: false,
    message: null,
  },
  entry: null,
  role: "editor",
  hostLabel: null,
  restoreMutate: vi.fn(),
  deleteMutate: vi.fn(),
  openInBrowserMutate: vi.fn(),
  restorePending: false,
  deletePending: false,
  openInBrowserPending: false,
  openBrowserUrl: vi.fn(),
}));

vi.mock("@/lib/files/byte-source", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/files/byte-source")
  >("@/lib/files/byte-source");
  return {
    ...actual,
    useFileBytes: () => state.bytes,
  };
});

vi.mock("@/hooks/epic/use-epic-files", () => ({
  useEpicFileEntry: () => state.entry,
  useEpicDeleteFile: () => ({
    mutate: state.deleteMutate,
    isPending: state.deletePending,
  }),
  useEpicRestoreFile: () => ({
    mutate: state.restoreMutate,
    isPending: state.restorePending,
  }),
  useEpicOpenFileInBrowser: () => ({
    mutate: state.openInBrowserMutate,
    isPending: state.openInBrowserPending,
  }),
}));

vi.mock("@/lib/links/open-browser-url", () => ({
  useOpenBrowserUrl: () => state.openBrowserUrl,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => state.role,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () =>
    state.hostLabel === null ? null : { label: state.hostLabel },
}));

// Heavy viewer modules - stubbed to keep the suite out of pdf.js / canvas
// image decoding, per the file's own docs on why these are stubbed AS-IS.
vi.mock("@/components/epic-canvas/image-preview/image-preview", () => ({
  DEFAULT_ANIMATION_MS: 200,
  ImagePreview: (props: { readonly url: string }) => (
    <div data-testid="epic-file-image-viewer" data-url={props.url} />
  ),
}));

vi.mock("@/components/epic-canvas/pdf-preview/pdf-preview-lazy", () => ({
  PDF_VIEWER_UNAVAILABLE_REASON: "The PDF viewer could not be loaded.",
  PdfPreviewLazy: (props: { readonly url: string }) => (
    <div data-testid="epic-file-pdf-viewer" data-url={props.url} />
  ),
}));

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-renderer",
  () => ({
    WorkspaceFileRenderer: (props: { readonly content: string }) => (
      <div data-testid="epic-file-text-viewer">{props.content}</div>
    ),
  }),
);

import { EpicFileTile } from "../epic-file-tile";

function makeEntry(overrides: {
  readonly kind?: string;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly producer?: EpicFileProducer;
  readonly status?: string;
  readonly deletedAt?: number | null;
}): EpicFileEntry {
  return {
    v: 1,
    kind: overrides.kind ?? "file",
    current: {
      sha256: "a".repeat(64),
      byteLength: overrides.byteLength ?? 2048,
      mediaType: overrides.mediaType ?? "text/plain",
      createdAt: 1_700_000_000_000,
      createdBy: "user-should-never-render-abc123",
      producer: overrides.producer ?? { type: "user" },
    },
    versions: [],
    status: overrides.status ?? "available",
    recordingId: null,
    derivedFrom: [],
    deletedAt: overrides.deletedAt ?? null,
  };
}

function ready(mediaType: string, src = "blob:epic-file"): FileBytesState {
  return {
    status: "ready",
    src,
    mediaType,
    delivery: "blob",
    reason: null,
    header: null,
    servedFromCache: false,
    message: null,
  };
}

function unavailable(
  reason: FileBytesUnavailableReason | null,
): FileBytesState {
  return {
    status: "unavailable",
    src: null,
    mediaType: null,
    delivery: null,
    reason,
    header: null,
    servedFromCache: false,
    message: null,
  };
}

/**
 * `expect.any` is typed `any`; parked on an `unknown` const so the matcher can
 * sit inside an object literal without an unsafe assignment.
 */
const ANY_FUNCTION: unknown = expect.any(Function);

const NODE: EpicFileTileRef = makeEpicFileTileRef({
  hostId: "host-A",
  epicId: "epic-1",
  path: "files/report.png",
});

function renderTile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <EpicFileTile node={NODE} viewTabId="tab-1" epicId="epic-1" />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.bytes = LOADING_BYTES;
  state.entry = null;
  state.role = "editor";
  state.hostLabel = null;
  state.restoreMutate.mockReset();
  state.deleteMutate.mockReset();
  state.openInBrowserMutate.mockReset();
  state.restorePending = false;
  state.deletePending = false;
  state.openInBrowserPending = false;
  state.openBrowserUrl.mockReset();

  // `EpicFileTextViewer` decodes its bytes via `globalThis.fetch`; stub it so
  // the text/html families settle deterministically instead of hitting a real
  // (or absent) network in jsdom.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response("hello from the epic file", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("<EpicFileTile /> byte states", () => {
  it("renders the loading spinner while bytes are loading", () => {
    state.entry = makeEntry({});
    state.bytes = LOADING_BYTES;
    renderTile();

    expect(screen.getByTestId("epic-file-loading")).toBeTruthy();
  });

  it("names the host label for an upload still in progress", () => {
    state.entry = makeEntry({ status: "pending" });
    state.bytes = unavailable("upload-pending");
    state.hostLabel = "Alice's MacBook";
    renderTile();

    expect(screen.getByText("Uploading from Alice's MacBook.")).toBeTruthy();
  });

  it("falls back to generic upload-pending copy with no host label", () => {
    state.entry = makeEntry({ status: "pending" });
    state.bytes = unavailable("upload-pending");
    state.hostLabel = null;
    renderTile();

    expect(
      screen.getByText("The device that made this file is still uploading it."),
    ).toBeTruthy();
  });

  it("shows the 'kept on the device' copy for a local-only, never-uploaded file", () => {
    state.entry = makeEntry({ status: "local-only" });
    state.bytes = unavailable("upload-unavailable");
    renderTile();

    expect(screen.getByText("Kept on the device that made it")).toBeTruthy();
    expect(
      screen.getByText(
        "This file was never uploaded, so only the device that produced it can open it.",
      ),
    ).toBeTruthy();
  });

  it("shows the 'upload failed' copy for a failed upload", () => {
    state.entry = makeEntry({ status: "failed" });
    state.bytes = unavailable("upload-unavailable");
    renderTile();

    expect(screen.getByText("The upload failed")).toBeTruthy();
  });

  it("shows the unsupported-host copy", () => {
    state.entry = makeEntry({});
    state.bytes = {
      status: "unsupported",
      src: null,
      mediaType: null,
      delivery: null,
      reason: null,
      header: null,
      servedFromCache: false,
      message: null,
    };
    renderTile();

    expect(screen.getByText("This device can't open epic files")).toBeTruthy();
  });
});

describe("<EpicFileTile /> deleted entry", () => {
  it("shows the no-longer-available copy and a Restore action for an editor", () => {
    state.entry = makeEntry({ deletedAt: 1_700_000_000_000 });
    state.role = "editor";
    renderTile();

    expect(screen.getByText("This file is no longer available")).toBeTruthy();
    const restore = screen.getByTestId("epic-file-restore");
    fireEvent.click(restore);
    expect(state.restoreMutate).toHaveBeenCalledWith({
      epicId: NODE.epicId,
      path: NODE.path,
    });
  });

  it("hides the Restore action for a viewer", () => {
    state.entry = makeEntry({ deletedAt: 1_700_000_000_000 });
    state.role = "viewer";
    renderTile();

    expect(screen.getByText("This file is no longer available")).toBeTruthy();
    expect(screen.queryByTestId("epic-file-restore")).toBeNull();
  });
});

describe("<EpicFileTile /> header", () => {
  it("renders name/path, kind, size 'used' (never 'live'), producer role and status - never the creator id", () => {
    state.entry = makeEntry({
      kind: "screenshot",
      byteLength: 1536,
      producer: { type: "user" },
      status: "available",
    });
    state.bytes = ready("image/png");
    renderTile();

    const header = screen.getByTestId("epic-file-header");
    expect(header.textContent).toContain(NODE.path);
    expect(screen.getByTestId("epic-file-kind").textContent).toBe("screenshot");
    expect(screen.getByTestId("epic-file-size").textContent).toBe(
      "1.5 KiB used",
    );
    expect(screen.getByTestId("epic-file-size").textContent).not.toContain(
      "live",
    );
    expect(screen.getByTestId("epic-file-producer").textContent).toBe("person");
    expect(screen.getByTestId("epic-file-status").textContent).toBe(
      "Available",
    );
    // The manifest's `createdBy` is a user id (D31) - it must never reach the
    // DOM, anywhere in the tile.
    expect(document.body.textContent).not.toContain(
      "user-should-never-render-abc123",
    );
  });

  it("renders 'agent' for an agent-produced file", () => {
    state.entry = makeEntry({
      producer: { type: "agent", chatId: "chat-1" },
    });
    state.bytes = ready("text/plain");
    renderTile();

    expect(screen.getByTestId("epic-file-producer").textContent).toBe("agent");
  });
});

describe("<EpicFileTile /> ready viewers", () => {
  it("renders the image viewer for image/png", () => {
    state.entry = makeEntry({ mediaType: "image/png" });
    state.bytes = ready("image/png", "blob:png-bytes");
    renderTile();

    const viewer = screen.getByTestId("epic-file-image-viewer");
    expect(viewer.getAttribute("data-url")).toBe("blob:png-bytes");
  });

  it("renders text/plain without throwing", () => {
    state.entry = makeEntry({ mediaType: "text/plain" });
    state.bytes = ready("text/plain");
    expect(() => renderTile()).not.toThrow();
  });

  it("renders application/octet-stream without throwing", () => {
    state.entry = makeEntry({ mediaType: "application/octet-stream" });
    state.bytes = ready("application/octet-stream");
    expect(() => renderTile()).not.toThrow();
  });
});

describe("<EpicFileTile /> open-in-browser flow", () => {
  it("shows the action for text/html and opens the returned url through useOpenBrowserUrl()", () => {
    state.entry = makeEntry({ mediaType: "text/html" });
    state.bytes = ready("text/html");
    state.openInBrowserMutate.mockImplementation(
      (
        _variables: { readonly epicId: string; readonly path: string },
        options: { readonly onSuccess: (response: { url: string }) => void },
      ) => {
        options.onSuccess({ url: "http://127.0.0.1:9999/files/report.html" });
      },
    );
    renderTile();

    const button = screen.getByTestId("epic-file-open-in-browser");
    fireEvent.click(button);

    expect(state.openInBrowserMutate).toHaveBeenCalledWith(
      { epicId: NODE.epicId, path: NODE.path },
      expect.objectContaining({ onSuccess: ANY_FUNCTION }),
    );
    expect(state.openBrowserUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:9999/files/report.html",
        epicId: "epic-1",
        viewTabId: "tab-1",
      }),
    );
  });

  it("does not show the open-in-browser action for a non-html file", () => {
    state.entry = makeEntry({ mediaType: "text/plain" });
    state.bytes = ready("text/plain");
    renderTile();

    expect(screen.queryByTestId("epic-file-open-in-browser")).toBeNull();
  });
});
