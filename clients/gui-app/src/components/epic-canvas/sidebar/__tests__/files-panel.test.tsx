import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicStateFileRecord } from "@traycer/protocol/host/epic/files";
import { FilesPanelBody } from "@/components/epic-canvas/sidebar/files-panel";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import type { FilesSlice } from "@/stores/epics/open-epic/types";
import { TILE_KIND_EPIC_FILE } from "@/stores/epics/canvas/tile-kinds";
import {
  fileRecord,
  shaFor,
} from "@/lib/files/__tests__/epic-file-record-fixture";

const HOST_ID = "host-1";

const mocks = vi.hoisted(() => {
  const files: { current: FilesSlice } = {
    current: { served: true, records: [] },
  };
  const hostId: { current: string | null } = { current: "host-1" };
  return { files, hostId, openTile: vi.fn<(intent: TileOpenIntent) => null>() };
});

vi.mock("@/lib/epic-selectors", () => ({
  useEpicFiles: () => mocks.files.current,
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => mocks.hostId.current,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));

const PAGE_V1 = "files/pages/report.html";
const PAGE_V2 = "files/pages/report-2.html";

function setFiles(records: readonly EpicStateFileRecord[]): void {
  mocks.files.current = { served: true, records };
}

function renderPanel(): void {
  render(<FilesPanelBody epicId="epic-1" tabId="tab-1" />);
}

function row(path: string): HTMLElement {
  return screen.getByTestId(`epic-files-item-${path}`);
}

beforeEach(() => {
  mocks.files.current = { served: true, records: [] };
  mocks.hostId.current = HOST_ID;
  mocks.openTile.mockReset();
});

afterEach(cleanup);

describe("<FilesPanelBody /> groups", () => {
  it("draws Pages, MCP apps, folders and the root in that order, with counts on the first two", () => {
    setFiles([
      fileRecord({ path: "files/notes.txt" }),
      fileRecord({ path: "files/drops/a.png" }),
      fileRecord({ path: "files/mcp-apps/chart.html" }),
      fileRecord({ path: PAGE_V1 }),
      fileRecord({ path: "files/pages/other.html" }),
    ]);

    renderPanel();

    const groups = screen
      .getAllByTestId(/^epic-files-group-/)
      .map((group) => group.textContent);
    expect(groups).toEqual(["Pages2", "MCP apps1", "drops", "Other files"]);
  });

  it("shows Pages open and MCP apps closed until its header is clicked", () => {
    setFiles([
      fileRecord({ path: PAGE_V1 }),
      fileRecord({ path: "files/mcp-apps/chart.html" }),
    ]);

    renderPanel();

    expect(row(PAGE_V1)).toBeTruthy();
    expect(screen.queryByText("chart.html")).toBeNull();

    fireEvent.click(screen.getByTestId("epic-files-group-mcp-apps"));

    expect(screen.getByText("chart.html")).toBeTruthy();
  });

  it("says every task member can see the files, private chats' pages included", () => {
    setFiles([fileRecord({ path: PAGE_V1 })]);

    renderPanel();

    expect(
      screen.getByText(
        "Everyone in this task can see these files, also pages from private chats.",
      ),
    ).toBeTruthy();
  });

  it("hides a deleted file", () => {
    setFiles([
      fileRecord({ path: PAGE_V1, deletedAt: 5000 }),
      fileRecord({ path: "files/kept.txt" }),
    ]);

    renderPanel();

    expect(screen.queryByText("report.html")).toBeNull();
    expect(screen.getByText("kept.txt")).toBeTruthy();
  });
});

describe("<FilesPanelBody /> versions", () => {
  it("shows a replaced page as an Earlier version under the page that replaced it", () => {
    setFiles([
      fileRecord({ path: PAGE_V1, createdAt: 1000 }),
      fileRecord({ path: PAGE_V2, createdAt: 2000, replaces: PAGE_V1 }),
    ]);

    renderPanel();

    expect(row(PAGE_V2).textContent).toContain("report-2.html");
    expect(row(PAGE_V1).textContent).toContain("Earlier version");
    expect(screen.queryByText("report.html")).toBeNull();
  });
});

describe("<FilesPanelBody /> bytes this host does not hold", () => {
  it("marks only the file that downloads on first open", () => {
    setFiles([
      fileRecord({ path: "files/big.mov", localState: { kind: "absent" } }),
      fileRecord({ path: "files/here.png", localState: { kind: "present" } }),
    ]);

    renderPanel();

    expect(
      row("files/big.mov").querySelector(
        '[aria-label="Downloads on first open"]',
      ),
    ).not.toBeNull();
    expect(
      row("files/here.png").querySelector(
        '[aria-label="Downloads on first open"]',
      ),
    ).toBeNull();
  });
});

describe("<FilesPanelBody /> without files", () => {
  it("says the host has no files plane when the lane never served the set", () => {
    mocks.files.current = { served: false, records: [] };

    renderPanel();

    expect(
      screen.getByText("Files aren't available on this host."),
    ).toBeTruthy();
    expect(screen.queryByText("No files yet.")).toBeNull();
  });

  it("says there are no files yet when the lane served an empty set", () => {
    renderPanel();

    expect(screen.getByText("No files yet.")).toBeTruthy();
    expect(
      screen.queryByText("Files aren't available on this host."),
    ).toBeNull();
  });
});

describe("<FilesPanelBody /> opening a file", () => {
  it("opens the epic-file tile for the clicked row's path and sha, bound to the canvas host", () => {
    setFiles([fileRecord({ path: PAGE_V1 })]);

    renderPanel();
    fireEvent.click(row(PAGE_V1));

    expect(mocks.openTile).toHaveBeenCalledTimes(1);
    const intent = mocks.openTile.mock.calls[0][0];
    expect(intent.target).toEqual({ epicId: "epic-1" });
    expect(intent.node).toMatchObject({
      type: TILE_KIND_EPIC_FILE,
      path: PAGE_V1,
      sha256: shaFor(PAGE_V1),
      hostId: HOST_ID,
      via: null,
    });
  });

  it("opens the earlier version at its own sha", () => {
    setFiles([
      fileRecord({ path: PAGE_V1, createdAt: 1000 }),
      fileRecord({ path: PAGE_V2, createdAt: 2000, replaces: PAGE_V1 }),
    ]);

    renderPanel();
    fireEvent.click(row(PAGE_V1));

    expect(mocks.openTile.mock.calls[0][0].node).toMatchObject({
      path: PAGE_V1,
      sha256: shaFor(PAGE_V1),
    });
  });

  it("cannot open anything while no host serves the canvas", () => {
    mocks.hostId.current = null;
    setFiles([fileRecord({ path: PAGE_V1 })]);

    renderPanel();
    fireEvent.click(row(PAGE_V1));

    expect(row(PAGE_V1)).toHaveProperty("disabled", true);
    expect(mocks.openTile).not.toHaveBeenCalled();
  });
});
