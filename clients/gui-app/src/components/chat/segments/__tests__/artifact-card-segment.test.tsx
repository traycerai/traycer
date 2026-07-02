import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactCardSegment } from "@/components/chat/segments/artifact-card-segment";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";

type TestArtifactProjection = {
  readonly id: string;
  readonly kind: EpicArtifactKind;
  readonly title: string;
  readonly status: number | null;
};

type TestDeletedArtifactProjection = TestArtifactProjection & {
  readonly deletedAt: string;
};

type TestProjectionState = {
  artifacts: Record<string, TestArtifactProjection>;
  deleted: Record<string, TestDeletedArtifactProjection>;
  hostId: string | null;
};

// Mutable projection state the mocked selectors read on every render, so a test
// can flip an id from absent → present and re-render to exercise the card's
// reactive (subscription, not one-shot) resolution.
const projection = vi.hoisted<TestProjectionState>(() => ({
  artifacts: {},
  deleted: {},
  hostId: "host-1",
}));

const canvas = vi.hoisted(() => ({
  resolveTargetTabForEpic: vi.fn(() => "tab-1"),
  openTileInTab: vi.fn<(tabId: string, node: EpicArtifactRef) => void>(),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useArtifactById: (id: string | null) =>
    id !== null && Object.hasOwn(projection.artifacts, id)
      ? projection.artifacts[id]
      : null,
  useEpicDeletedArtifact: (id: string | null) =>
    id !== null && Object.hasOwn(projection.deleted, id)
      ? projection.deleted[id]
      : null,
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => projection.hostId,
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: { getState: () => canvas },
}));

vi.mock("@/components/chat/segments/snapshot-hash-inline-diff", () => ({
  SnapshotHashInlineDiff: () => <div data-testid="artifact-inline-diff" />,
}));

describe("<ArtifactCardSegment />", () => {
  beforeEach(() => {
    projection.artifacts = {};
    projection.deleted = {};
    projection.hostId = "host-1";
    canvas.resolveTargetTabForEpic.mockClear();
    canvas.openTileInTab.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it("renders a create with the live title, kind, and a green '+' badge", () => {
    projection.artifacts["a1"] = {
      id: "a1",
      kind: "spec",
      title: "Auth Spec",
      status: null,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="create"
        artifactKind="spec"
        artifactId="a1"
        title={null}
        change={null}
      />,
    );

    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("+")).toBeTruthy();
    expect(screen.getByText("Auth Spec")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Auth Spec" })).toBeTruthy();
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("shows the file-diff toggle when the artifact has a captured change", () => {
    projection.artifacts["a1"] = {
      id: "a1",
      kind: "spec",
      title: "Auth Spec",
      status: null,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="spec"
        artifactId="a1"
        title={null}
        change={{
          beforeHash: "h0",
          afterHash: "h1",
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "View diff" })).toBeTruthy();
  });

  it("does not keep the diff latched open when change data disappears", () => {
    projection.artifacts["a1"] = {
      id: "a1",
      kind: "spec",
      title: "Auth Spec",
      status: null,
    };
    const { rerender } = render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="spec"
        artifactId="a1"
        title={null}
        change={{
          beforeHash: "h0",
          afterHash: "h1",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    expect(screen.getByTestId("artifact-inline-diff")).toBeTruthy();
    rerender(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="spec"
        artifactId="a1"
        title={null}
        change={null}
      />,
    );
    expect(screen.queryByTestId("artifact-inline-diff")).toBeNull();
    rerender(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="spec"
        artifactId="a1"
        title={null}
        change={{
          beforeHash: "h0",
          afterHash: "h1",
        }}
      />,
    );

    expect(screen.queryByTestId("artifact-inline-diff")).toBeNull();
    expect(screen.getByRole("button", { name: "View diff" })).toBeTruthy();
  });

  it("omits the file-diff toggle when there is no captured change", () => {
    projection.artifacts["a1"] = {
      id: "a1",
      kind: "spec",
      title: "Auth Spec",
      status: null,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="spec"
        artifactId="a1"
        title={null}
        change={null}
      />,
    );

    expect(screen.queryByRole("button", { name: "View diff" })).toBeNull();
  });

  it("omits the toggle for an update whose after-hash is null (incomplete / binary capture)", () => {
    projection.artifacts["a1"] = {
      id: "a1",
      kind: "spec",
      title: "Auth Spec",
      status: null,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="spec"
        artifactId="a1"
        title={null}
        change={{ beforeHash: "h0", afterHash: null }}
      />,
    );

    // A non-delete with no after-hash must NOT offer an all-deletions diff.
    expect(screen.queryByRole("button", { name: "View diff" })).toBeNull();
  });

  it("shows the toggle for a delete with a before-hash (all-deletions diff)", () => {
    projection.deleted["d1"] = {
      id: "d1",
      kind: "spec",
      title: "Removed Spec",
      deletedAt: "2026-06-10T00:00:00Z",
      status: null,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="delete"
        artifactKind="spec"
        artifactId="d1"
        title={null}
        change={{ beforeHash: "h0", afterHash: null }}
      />,
    );

    expect(screen.getByRole("button", { name: "View diff" })).toBeTruthy();
  });

  it("renders an update with the live ticket status and an amber badge", () => {
    projection.artifacts["t1"] = {
      id: "t1",
      kind: "ticket",
      title: "Wire the card",
      status: 1,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="ticket"
        artifactId="t1"
        title={null}
        change={null}
      />,
    );

    expect(screen.getByText("Updated")).toBeTruthy();
    expect(screen.getByText("Wire the card")).toBeTruthy();
    // Live ticket status appears in the secondary kind + status line.
    expect(screen.getByText("Ticket · In Progress")).toBeTruthy();
  });

  it("renders a delete from the tombstone: strikethrough title, no Open, '−' badge", () => {
    projection.deleted["d1"] = {
      id: "d1",
      kind: "spec",
      title: "Removed Spec",
      deletedAt: "2026-06-10T00:00:00Z",
      status: null,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="delete"
        artifactKind="spec"
        artifactId="d1"
        title={null}
        change={null}
      />,
    );

    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByText("−")).toBeTruthy();
    const title = screen.getByText("Removed Spec");
    expect(title.className).toContain("line-through");
    expect(title.getAttribute("title")).toBe("This artifact was deleted.");
    expect(screen.queryByText("deleted")).toBeNull();
    // A tombstone has no body - it cannot be opened.
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("renders a delete with a fallback title before the tombstone projects", () => {
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="delete"
        artifactKind="spec"
        artifactId="pending-delete"
        title="Fallback Deleted Spec"
        change={null}
      />,
    );

    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByText("−")).toBeTruthy();
    const title = screen.getByText("Fallback Deleted Spec");
    expect(title.className).toContain("line-through");
    expect(title.getAttribute("title")).toBe("This artifact was deleted.");
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("renders an unavailable titled update with deleted styling but keeps the update badge", () => {
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="spec"
        artifactId="deleted-before-tombstone"
        title="Deleted Before Tombstone"
        change={null}
      />,
    );

    expect(screen.getByText("Updated")).toBeTruthy();
    expect(screen.queryByText("Deleted")).toBeNull();
    expect(screen.queryByText("−")).toBeNull();
    const title = screen.getByText("Deleted Before Tombstone");
    expect(title.className).toContain("line-through");
    expect(title.getAttribute("title")).toBe("This artifact was deleted.");
    expect(screen.queryByText("deleted")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("renders an unavailable titled create with deleted styling but keeps the create badge", () => {
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="create"
        artifactKind="spec"
        artifactId="created-then-missing"
        title="Missing Created Spec"
        change={null}
      />,
    );

    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("+")).toBeTruthy();
    expect(screen.queryByText("Deleted")).toBeNull();
    expect(screen.queryByText("−")).toBeNull();
    const title = screen.getByText("Missing Created Spec");
    expect(title.className).toContain("line-through");
    expect(title.getAttribute("title")).toBe("This artifact was deleted.");
    expect(screen.queryByText("deleted")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("renders a graceful pending placeholder for an unresolved id, then resolves without remount", () => {
    const { rerender } = render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="create"
        artifactKind="spec"
        artifactId="late"
        title={null}
        change={null}
      />,
    );

    // Pending: badge + kind placeholder in title, meta line also shows "Spec",
    // not openable yet.
    expect(screen.getByText("Created")).toBeTruthy();
    // Both the italic title placeholder and the meta line show the kind label.
    expect(screen.getAllByText("Spec").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();

    // The id syncs into the projection; a re-render re-reads the subscription.
    projection.artifacts["late"] = {
      id: "late",
      kind: "spec",
      title: "Arrived Late",
      status: null,
    };
    rerender(
      <ArtifactCardSegment
        findUnitId={null}
        operation="create"
        artifactKind="spec"
        artifactId="late"
        title={null}
        change={null}
      />,
    );

    expect(screen.getByText("Arrived Late")).toBeTruthy();
    // After resolve: title placeholder is gone; only the meta line shows "Spec".
    expect(screen.getAllByText("Spec")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Open Arrived Late" }),
    ).toBeTruthy();
  });

  it("opens the artifact in the epic's canvas on click", () => {
    projection.artifacts["a1"] = {
      id: "a1",
      kind: "story",
      title: "My Story",
      status: 2,
    };
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="story"
        artifactId="a1"
        title={null}
        change={null}
      />,
    );

    fireEvent.click(screen.getByText("My Story"));

    expect(canvas.resolveTargetTabForEpic).toHaveBeenCalledWith(
      "epic-1",
      undefined,
    );
    expect(canvas.openTileInTab).toHaveBeenCalledTimes(1);
    const [tabId, node] = canvas.openTileInTab.mock.calls[0];
    expect(tabId).toBe("tab-1");
    expect(node).toMatchObject({
      id: "a1",
      type: "story",
      name: "My Story",
      hostId: "host-1",
    });
    expect(typeof node.instanceId).toBe("string");
  });

  it("stays non-crashing and non-openable for an entirely unknown id", () => {
    render(
      <ArtifactCardSegment
        findUnitId={null}
        operation="update"
        artifactKind="review"
        artifactId="ghost"
        title={null}
        change={null}
      />,
    );

    // Both the italic title placeholder and the meta line show the kind label.
    expect(screen.getAllByText("Review").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });
});
