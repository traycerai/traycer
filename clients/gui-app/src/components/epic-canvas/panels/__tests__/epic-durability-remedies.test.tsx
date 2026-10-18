/**
 * The paused-recovery export button builds its archive from
 * `useEpicArtifactRecords()`, filtered to Markdown kinds: a recovery archive
 * is a document bundle, and html/canvas/file records have no document body
 * to put in one.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpicDurabilityRemedies } from "@/components/epic-canvas/panels/epic-durability-remedies";

const mocks = vi.hoisted(() => ({
  records: [] as Array<{
    readonly id: string;
    readonly name: string;
    readonly type: string;
  }>,
  exportMutate: vi.fn(),
}));

vi.mock("@/hooks/epic/use-epic-export-artifacts-mutation", () => ({
  useEpicExportArtifacts: () => ({
    mutate: mocks.exportMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => mocks.records,
  useEpicDurabilityPauseReason: () => "access-revoked" as const,
  useEpicDurabilityView: () => ({
    kind: "stated" as const,
    status: "paused" as const,
  }),
  useEpicSnapshotMeta: () => ({ epicLight: { title: "My Epic" } }),
}));

afterEach(() => {
  cleanup();
  mocks.records = [];
  mocks.exportMutate.mockReset();
});

describe("<EpicDurabilityRemedies /> export-as-recovery-archive", () => {
  it("disables export and builds an empty archive when only object artifacts are present", () => {
    mocks.records = [
      { id: "h1", name: "Landing Page", type: "html" },
      { id: "c1", name: "Design Board", type: "canvas" },
      { id: "f1", name: "Report", type: "file" },
    ];

    render(<EpicDurabilityRemedies />);

    expect(screen.getByTestId("epic-durability-export")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("archives only the markdown records out of a mixed set", () => {
    mocks.records = [
      { id: "a1", name: "Auth Spec", type: "spec" },
      { id: "h1", name: "Landing Page", type: "html" },
      { id: "t1", name: "Wire the card", type: "ticket" },
      { id: "f1", name: "Report", type: "file" },
    ];

    render(<EpicDurabilityRemedies />);
    const button = screen.getByTestId("epic-durability-export");
    expect(button).toHaveProperty("disabled", false);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(mocks.exportMutate).toHaveBeenCalledExactlyOnceWith({
      artifacts: [
        { id: "a1", title: "Auth Spec" },
        { id: "t1", title: "Wire the card" },
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "My Epic",
    });
  });
});
