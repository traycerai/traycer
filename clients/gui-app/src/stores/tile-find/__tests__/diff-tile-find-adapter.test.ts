import { describe, expect, it, vi } from "vitest";
import {
  createDiffTileFindAdapter,
  createLoadedDiffTileFindSource,
  createLoadingDiffTileFindSource,
  createMetadataOnlyDiffTileFindSource,
  createMissingDiffTileFindSource,
  type DiffTileFindRenderer,
} from "@/stores/tile-find";
import type { DiffFindMatch } from "@/lib/diff/diff-find";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-const label = 'OldName';",
  "+const label = 'NewName';",
  "",
].join("\n");

interface RendererHarness {
  readonly renderer: DiffTileFindRenderer;
  readonly revealCalls: Array<{
    readonly matches: ReadonlyArray<DiffFindMatch>;
    readonly activeMatch: DiffFindMatch | null;
  }>;
}

function createRendererHarness(): RendererHarness {
  const revealCalls: RendererHarness["revealCalls"] = [];
  return {
    revealCalls,
    renderer: {
      reveal: (matches, activeMatch) => {
        revealCalls.push({ matches, activeMatch });
        return "painted";
      },
      clear: vi.fn(),
    },
  };
}

describe("createDiffTileFindAdapter", () => {
  it("reports loading and missing sources as unavailable", () => {
    const loadingAdapter = createDiffTileFindAdapter({
      tileInstanceId: "git-loading",
      tileKind: "git-diff",
      source: createLoadingDiffTileFindSource({
        coverageMessage: "Diff content is still loading.",
      }),
      renderer: null,
    });
    void loadingAdapter.search({
      requestId: 1,
      query: "app",
      matchCase: false,
    });

    expect(loadingAdapter.getSnapshot()).toMatchObject({
      requestId: 1,
      status: "unavailable",
      current: 0,
      total: 0,
      coverageMessage: "Diff content is still loading.",
      exactHighlight: "none",
    });
    expect(loadingAdapter.getSnapshot().capabilities.has("find")).toBe(false);

    const missingAdapter = createDiffTileFindAdapter({
      tileInstanceId: "snapshot-missing",
      tileKind: "snapshot-diff",
      source: createMissingDiffTileFindSource({
        coverageMessage: "Snapshot source content is unavailable.",
      }),
      renderer: null,
    });
    void missingAdapter.search({
      requestId: 2,
      query: "app",
      matchCase: false,
    });

    expect(missingAdapter.getSnapshot()).toMatchObject({
      requestId: 2,
      status: "unavailable",
      current: 0,
      total: 0,
      coverageMessage: "Snapshot source content is unavailable.",
    });
    expect(missingAdapter.getSnapshot().capabilities.has("find")).toBe(false);
  });

  it("searches binary metadata as partial without claiming row highlights", () => {
    const adapter = createDiffTileFindAdapter({
      tileInstanceId: "git-binary",
      tileKind: "git-diff",
      source: createMetadataOnlyDiffTileFindSource({
        metadataUnits: [
          {
            id: "binary:src/logo.png",
            filePath: "src/logo.png",
            scopeId: null,
            text: "logo.png src binary",
          },
        ],
        coverageMessage:
          "Binary diff content is unavailable; only file metadata was searched.",
      }),
      renderer: null,
    });
    void adapter.search({
      requestId: 1,
      query: "logo",
      matchCase: false,
    });

    expect(adapter.getSnapshot()).toMatchObject({
      status: "partial",
      current: 1,
      total: 1,
      activeUnitId: "metadata:binary:src/logo.png",
      exactHighlight: "none",
      coverageMessage:
        "Binary diff content is unavailable; only file metadata was searched.",
    });
    expect(adapter.getSnapshot().capabilities.has("find")).toBe(true);
  });

  it("searches loaded truncated patch content and navigates active matches", () => {
    const harness = createRendererHarness();
    const adapter = createDiffTileFindAdapter({
      tileInstanceId: "git-loaded",
      tileKind: "git-diff",
      source: createLoadedDiffTileFindSource({
        patch: PATCH,
        metadataUnits: [
          {
            id: "header:src/app.ts",
            filePath: "src/app.ts",
            scopeId: null,
            text: "app.ts src staged header",
          },
        ],
        cacheKey: "loaded-truncated",
        isPartial: true,
        partialMessage: "Only the loaded portion was searched.",
      }),
      renderer: harness.renderer,
    });

    void adapter.search({
      requestId: 1,
      query: "const",
      matchCase: false,
    });
    expect(adapter.getSnapshot()).toMatchObject({
      status: "partial",
      current: 1,
      total: 2,
      coverageMessage: "Only the loaded portion was searched.",
      exactHighlight: "painted",
    });
    expect(harness.revealCalls).toHaveLength(1);
    expect(harness.revealCalls[0]?.activeMatch?.unit.side).toBe("deletions");

    void adapter.next();
    expect(adapter.getSnapshot().current).toBe(2);
    expect(harness.revealCalls[1]?.activeMatch?.unit.side).toBe("additions");

    void adapter.previous();
    expect(adapter.getSnapshot().current).toBe(1);
  });

  it("honors matchCase for loaded diff content", () => {
    const adapter = createDiffTileFindAdapter({
      tileInstanceId: "snapshot-loaded",
      tileKind: "snapshot-diff",
      source: createLoadedDiffTileFindSource({
        patch: PATCH,
        metadataUnits: [],
        cacheKey: "loaded-match-case",
        isPartial: false,
        partialMessage: null,
      }),
      renderer: null,
    });

    void adapter.search({
      requestId: 1,
      query: "newname",
      matchCase: false,
    });
    expect(adapter.getSnapshot()).toMatchObject({
      status: "ready",
      total: 1,
    });

    void adapter.search({
      requestId: 2,
      query: "newname",
      matchCase: true,
    });
    expect(adapter.getSnapshot()).toMatchObject({
      status: "ready",
      total: 0,
    });
  });
});
