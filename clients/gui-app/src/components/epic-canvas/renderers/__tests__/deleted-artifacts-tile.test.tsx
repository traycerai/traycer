import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletedArtifactEntry } from "@traycer/protocol/host/epic/artifact-versions";
import { makeDeletedArtifactsTileRef } from "@/stores/epics/canvas/tile-schema/deleted-artifacts-tile";

const state = vi.hoisted(() => ({
  entries: [] as DeletedArtifactEntry[],
  blobs: new Map<string, string>(),
  loading: false,
  error: false,
  previewLoading: false,
  previewError: false,
  pendingArtifactId: null as string | null,
  queryCalls: [] as Array<{
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly enabled: boolean;
  }>,
  mutations: [] as Array<{
    readonly epicId: string;
    readonly artifactId: string;
  }>,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly options: { readonly enabled?: boolean } | null;
  }) => {
    const enabled = args.options?.enabled ?? true;
    state.queryCalls.push({
      method: args.method,
      params: args.params,
      enabled,
    });
    if (args.method === "epic.deletedArtifacts.list") {
      return {
        data: { entries: state.entries },
        isLoading: state.loading,
        isError: state.error,
        refetch: vi.fn(),
      };
    }
    const observationId = String(args.params.observationId);
    const markdown = state.blobs.get(observationId);
    return {
      data:
        enabled && markdown !== undefined
          ? { contentHash: "a".repeat(64), markdown }
          : undefined,
      isLoading: enabled && state.previewLoading,
      isError: enabled && state.previewError,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/markdown/traycer-markdown", () => ({
  TraycerMarkdown: (props: { readonly children: string }) => (
    <div data-testid="markdown-preview">{props.children}</div>
  ),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    isPending: state.pendingArtifactId !== null,
    variables: { artifactId: state.pendingArtifactId ?? "" },
    mutate: (variables: {
      readonly epicId: string;
      readonly artifactId: string;
    }) => {
      state.mutations.push(variables);
    },
  }),
}));

import { DeletedArtifactsTile } from "../deleted-artifacts-tile";

const EPIC_ID = "epic-a";

function renderTile(): void {
  render(
    <DeletedArtifactsTile
      node={makeDeletedArtifactsTileRef(EPIC_ID, "host-a")}
    />,
  );
}

describe("<DeletedArtifactsTile />", () => {
  beforeEach(() => {
    state.entries = [];
    state.blobs = new Map();
    state.loading = false;
    state.error = false;
    state.previewLoading = false;
    state.previewError = false;
    state.pendingArtifactId = null;
    state.queryCalls = [];
    state.mutations = [];
  });

  afterEach(cleanup);

  it("renders an epic-scoped empty state", () => {
    renderTile();

    expect(screen.getByText("No deleted artifacts")).toBeTruthy();
    expect(
      screen.getByText(
        "Restore artifacts retained in this epic's version history.",
      ),
    ).toBeTruthy();
  });

  it("restores a retained artifact", () => {
    state.entries = [
      {
        artifactId: "artifact-a",
        title: "Recovered plan",
        deletedAt: 1_700_000_000_000,
        versionCount: 3,
        lastContentHash: "a".repeat(64),
        lastObservationId: "observation-a",
        unrestorable: null,
      },
    ];
    renderTile();

    fireEvent.click(screen.getByRole("button", { name: "Restore artifact" }));

    expect(state.mutations).toEqual([
      { epicId: EPIC_ID, artifactId: "artifact-a" },
    ]);
  });

  it("explains and disables unrecoverable entries", () => {
    state.entries = [
      {
        artifactId: "artifact-scalars",
        title: "Lost metadata",
        deletedAt: 1_700_000_000_000,
        versionCount: 2,
        lastContentHash: "a".repeat(64),
        lastObservationId: "observation-scalars",
        unrestorable: "missing_scalars",
      },
      {
        artifactId: "artifact-blob",
        title: "Lost body",
        deletedAt: 1_700_000_100_000,
        versionCount: 1,
        lastContentHash: "b".repeat(64),
        lastObservationId: "observation-blob",
        unrestorable: "missing_blob",
      },
    ];
    renderTile();

    expect(
      screen.getByText(
        "Cannot restore: the artifact's title, kind, or tree position is missing.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Cannot restore: the saved artifact body is missing."),
    ).toBeTruthy();
    for (const button of screen.getAllByRole("button", {
      name: "Restore artifact",
    })) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });

  it("previews the latest saved body and follows artifact selection", () => {
    state.entries = [
      {
        artifactId: "artifact-a",
        title: "First plan",
        deletedAt: 1_700_000_000_000,
        versionCount: 3,
        lastContentHash: "a".repeat(64),
        lastObservationId: "observation-a",
        unrestorable: null,
      },
      {
        artifactId: "artifact-b",
        title: "Second plan",
        deletedAt: 1_700_000_100_000,
        versionCount: 2,
        lastContentHash: "b".repeat(64),
        lastObservationId: "observation-b",
        unrestorable: null,
      },
    ];
    state.blobs = new Map([
      ["observation-a", "# First saved body"],
      ["observation-b", "# Second saved body"],
    ]);

    renderTile();

    expect(screen.getByText("# First saved body")).toBeTruthy();
    expect(
      state.queryCalls.some(
        (call) =>
          call.method === "epic.artifactVersions.getBlob" &&
          call.enabled &&
          call.params.observationId === "observation-a",
      ),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview deleted artifact Second plan",
      }),
    );

    expect(screen.getByText("# Second saved body")).toBeTruthy();
  });
});
