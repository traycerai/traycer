/**
 * Cover for `FilesPanelBody` (D02/D06): the `Files` left panel that reads the
 * projector's `files` slice.
 *
 * Drives a real `openStoreForTest` store + Y.Doc through `EpicSessionContext`,
 * matching `artifact-search-availability.test.tsx` - so a manifest write
 * really does flow doc -> projector -> store -> render, and only the two
 * external boundaries the task calls out (tile navigation, canvas host id)
 * are faked.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { isEpicFileTileRef } from "@/stores/epics/canvas/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { FilesPanelBody } from "@/components/epic-canvas/sidebar/files-panel";

const openedTiles: TileOpenIntent[] = [];
const openTile = vi.fn((intent: TileOpenIntent) => {
  openedTiles.push(intent);
  return null;
});

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile }),
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-fixed",
}));

const inertStreamFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => {},
  awareness: () => {},
  applyArtifactRoomUpdate: () => {},
  artifactRoomAwareness: () => {},
  retryMigration: () => {},
  close: () => {},
});

let opened: OpenedStoreForTest | null = null;

afterEach(() => {
  cleanup();
  opened?.dispose();
  opened = null;
  openTile.mockClear();
  openedTiles.length = 0;
});

function openStore(): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: "epic-files-panel",
    userId: null,
    factories: {
      streamClientFactory: inertStreamFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  opened = handle;
  return handle;
}

interface EntryArgs {
  readonly kind: string;
  readonly status: string;
  readonly byteLength: number;
  readonly deletedAt: number | null;
  readonly recordingId: string | null;
  readonly sha256: string;
}

function entryValue(args: EntryArgs): Record<string, unknown> {
  return {
    v: 1,
    kind: args.kind,
    current: {
      sha256: args.sha256,
      byteLength: args.byteLength,
      mediaType: "text/plain",
      createdAt: 0,
      createdBy: "user-1",
      producer: { type: "user" },
    },
    status: args.status,
    deletedAt: args.deletedAt,
    recordingId: args.recordingId,
  };
}

let shaCounter = 0;
function nextSha(): string {
  shaCounter += 1;
  return String(shaCounter % 10).repeat(64);
}

function setFileEntry(
  handle: OpenedStoreForTest,
  path: string,
  value: unknown,
): void {
  act(() => {
    handle.doc.getMap("files").set(path, value);
  });
}

function renderPanel(handle: OpenedStoreForTest) {
  return render(
    <EpicSessionContext.Provider value={handle}>
      <FilesPanelBody epicId="epic-files-panel" tabId="tab-1" />
    </EpicSessionContext.Provider>,
  );
}

describe("FilesPanelBody against a real Epic store", () => {
  it("shows the empty state for a manifest with no entries", () => {
    const handle = openStore();
    renderPanel(handle);

    expect(screen.getByTestId("epic-files-empty")).toBeTruthy();
  });

  it("renders a row's name and size, badging pending/local-only/failed but not available", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({
        kind: "file",
        status: "available",
        byteLength: 100,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    setFileEntry(
      handle,
      "files/b.txt",
      entryValue({
        kind: "file",
        status: "pending",
        byteLength: 2048,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    setFileEntry(
      handle,
      "files/c.txt",
      entryValue({
        kind: "file",
        status: "local-only",
        byteLength: 500,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    setFileEntry(
      handle,
      "files/d.txt",
      entryValue({
        kind: "file",
        status: "failed",
        byteLength: 10,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    renderPanel(handle);

    const rowA = screen.getByTestId("epic-files-row-files/a.txt");
    expect(within(rowA).getByText("a.txt")).toBeTruthy();
    expect(within(rowA).getByText("100 B")).toBeTruthy();
    expect(within(rowA).queryByText("pending")).toBeNull();
    expect(within(rowA).queryByText("failed")).toBeNull();
    expect(within(rowA).queryByText("local-only")).toBeNull();

    const rowB = screen.getByTestId("epic-files-row-files/b.txt");
    expect(within(rowB).getByText("b.txt")).toBeTruthy();
    expect(within(rowB).getByText("2.0 KiB")).toBeTruthy();
    expect(within(rowB).getByText("pending")).toBeTruthy();

    const rowC = screen.getByTestId("epic-files-row-files/c.txt");
    expect(within(rowC).getByText("local-only")).toBeTruthy();

    const rowD = screen.getByTestId("epic-files-row-files/d.txt");
    expect(within(rowD).getByText("failed")).toBeTruthy();
  });

  it("hides recordings/artifact-images by default, revealed by the toggle", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/note.txt",
      entryValue({
        kind: "file",
        status: "available",
        byteLength: 10,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    setFileEntry(
      handle,
      "files/recordings/z-clip.mp4",
      entryValue({
        kind: "recording",
        status: "available",
        byteLength: 999,
        deletedAt: null,
        recordingId: "rec-1",
        sha256: nextSha(),
      }),
    );
    setFileEntry(
      handle,
      "files/artifact-images/abc.png",
      entryValue({
        kind: "artifact-image",
        status: "available",
        byteLength: 20,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    renderPanel(handle);

    expect(
      screen.queryByTestId("epic-files-row-files/recordings/z-clip.mp4"),
    ).toBeNull();
    expect(
      screen.queryByTestId("epic-files-row-files/artifact-images/abc.png"),
    ).toBeNull();

    const toggle = screen.getByRole("button", {
      name: /recordings and artifact images/i,
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByTestId("epic-files-row-files/recordings/z-clip.mp4"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("epic-files-row-files/artifact-images/abc.png"),
    ).toBeTruthy();
  });

  it("collapses three entries sharing a recordingId into the single 'recording' row", () => {
    const handle = openStore();
    // Deliberately out of collapse order (alphabetical by path puts the
    // recording-events entry first and the recording entry last), so this
    // proves the collapse picks the `recording` kind rather than "whichever
    // arrived first".
    setFileEntry(
      handle,
      "files/recordings/a-events.json",
      entryValue({
        kind: "recording-events",
        status: "available",
        byteLength: 30,
        deletedAt: null,
        recordingId: "rec-1",
        sha256: nextSha(),
      }),
    );
    setFileEntry(
      handle,
      "files/recordings/m-poster.png",
      entryValue({
        kind: "poster",
        status: "available",
        byteLength: 40,
        deletedAt: null,
        recordingId: "rec-1",
        sha256: nextSha(),
      }),
    );
    setFileEntry(
      handle,
      "files/recordings/z-clip.mp4",
      entryValue({
        kind: "recording",
        status: "available",
        byteLength: 5000,
        deletedAt: null,
        recordingId: "rec-1",
        sha256: nextSha(),
      }),
    );
    renderPanel(handle);

    fireEvent.click(
      screen.getByRole("button", { name: /recordings and artifact images/i }),
    );

    expect(
      screen.getByTestId("epic-files-row-files/recordings/z-clip.mp4"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("epic-files-row-files/recordings/a-events.json"),
    ).toBeNull();
    expect(
      screen.queryByTestId("epic-files-row-files/recordings/m-poster.png"),
    ).toBeNull();
  });

  it("hides tombstoned entries by default, revealed by the Deleted toggle", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/old-note.txt",
      entryValue({
        kind: "file",
        status: "available",
        byteLength: 15,
        deletedAt: 555,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    renderPanel(handle);

    expect(
      screen.queryByTestId("epic-files-row-files/old-note.txt"),
    ).toBeNull();

    const toggle = screen.getByRole("button", { name: /^deleted$/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const row = screen.getByTestId("epic-files-row-files/old-note.txt");
    expect(row).toBeTruthy();
    expect(row.getAttribute("aria-label")).toMatch(/deleted/i);
  });

  it("clicking a row opens the epic-file tile for that path exactly once", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({
        kind: "file",
        status: "available",
        byteLength: 100,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    renderPanel(handle);

    fireEvent.click(screen.getByTestId("epic-files-row-files/a.txt"));

    expect(openTile).toHaveBeenCalledTimes(1);
    const intent = openedTiles[0];
    expect(intent.node.type).toBe("epic-file");
    if (!isEpicFileTileRef(intent.node)) {
      throw new Error("expected an epic-file tile ref");
    }
    expect(intent.node.path).toBe("files/a.txt");
  });

  it("shows the D06 sharing copy and the storage-used figure", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({
        kind: "file",
        status: "available",
        byteLength: 100,
        deletedAt: null,
        recordingId: null,
        sha256: nextSha(),
      }),
    );
    renderPanel(handle);

    expect(screen.getByText(/everyone who can open this epic/i)).toBeTruthy();
    expect(screen.getByText(/used/i)).toBeTruthy();
  });
});
