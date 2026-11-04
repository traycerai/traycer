import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
  appLogger: { errorSummary: vi.fn() },
}));

vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: vi.fn(),
}));

vi.mock("@/lib/files/saved-file-toast", () => ({
  toastSavedFile: vi.fn(),
}));

const track = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: { getInstance: () => ({ track }) },
  };
});

const acquireResidentArtifactBodyLease = vi.hoisted(() => vi.fn());
const getArtifactFragment = vi.hoisted(() => vi.fn());
const createArtifactExport = vi.hoisted(() => vi.fn());
const serializeArtifactMarkdown = vi.hoisted(() => vi.fn());
// The export refusal gate reads this straight from the store, before any
// lease is taken - an id absent here (the common case: export often runs
// before this session has resolved the record) must not throw, only one
// whose KIND is known and non-Markdown must.
const artifactRecords = vi.hoisted(() => ({
  current: {} as Record<
    string,
    { readonly kind: string; readonly title: string }
  >,
}));
const artifactTree = vi.hoisted(() => ({
  current: {
    rootIds: [] as string[],
    childrenByParent: {},
    nodeById: {},
  },
}));

vi.mock("@/lib/artifacts/artifact-export", () => ({
  createArtifactExport,
  serializeArtifactMarkdown,
}));

const saveBlobToDisk = vi.hoisted(() => vi.fn());

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk,
  openSavedFile: vi.fn(),
  hasSeparateDownloadRoute: () => false,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: {
      getState: () => ({
        acquireResidentArtifactBodyLease,
        getArtifactFragment,
        artifacts: { byId: artifactRecords.current },
        tree: artifactTree.current,
      }),
    },
  }),
}));

import { AnalyticsEvent } from "@/lib/analytics";
import { useEpicExportArtifacts } from "@/hooks/epic/use-epic-export-artifacts-mutation";

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useEpicExportArtifacts", () => {
  beforeEach(() => {
    artifactRecords.current = {};
    artifactTree.current = { rootIds: [], childrenByParent: {}, nodeById: {} };
    saveBlobToDisk.mockReset();
    saveBlobToDisk.mockResolvedValue(null);
    track.mockReset();
    acquireResidentArtifactBodyLease.mockReset();
    getArtifactFragment.mockReset();
    createArtifactExport.mockReset();
    serializeArtifactMarkdown.mockReset();
    serializeArtifactMarkdown.mockReturnValue("# body");
    acquireResidentArtifactBodyLease.mockImplementation(() => ({
      release: vi.fn(),
      resident: Promise.resolve(),
    }));
    getArtifactFragment.mockReturnValue(new Y.Doc().getXmlFragment("body"));
    createArtifactExport.mockResolvedValue({
      blob: new Blob(["export"]),
      suggestedName: "export.md",
    });
  });

  it("rejects an empty artifact selection with the export validation error", async () => {
    const { result } = renderHook(() => useEpicExportArtifacts(), {
      wrapper: makeWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        artifacts: [],
        format: "markdown",
        archive: true,
        archiveTitle: null,
        includeNested: false,
      }),
    ).rejects.toThrow("Select at least one artifact to export.");
  });

  it("surfaces the loading copy and releases an unavailable body", async () => {
    const release = vi.fn();
    // Residency SETTLES and the fragment is still absent: the artifact has no
    // body this client can materialize at all, which is the case that must
    // still fail fast with the loading copy rather than park the export.
    acquireResidentArtifactBodyLease.mockImplementation(() => ({
      release,
      resident: Promise.resolve(),
    }));
    getArtifactFragment.mockReturnValue(null);
    const { result } = renderHook(() => useEpicExportArtifacts(), {
      wrapper: makeWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        artifacts: [{ id: "artifact-a", title: "Design" }],
        format: "markdown",
        archive: false,
        archiveTitle: null,
        includeNested: false,
      }),
    ).rejects.toThrow("“Design” is still loading.");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("takes artifact body leases sequentially and releases the first on a second failure", async () => {
    const firstFragment = new Y.Doc().getXmlFragment("first");
    const events: string[] = [];
    const firstRelease = vi.fn(() => {
      events.push("release:artifact-a");
    });
    const secondRelease = vi.fn(() => {
      events.push("release:artifact-b");
    });
    acquireResidentArtifactBodyLease.mockImplementation(
      (artifactId: string) => {
        events.push(`acquire:${artifactId}`);
        return {
          release: events.length === 1 ? firstRelease : secondRelease,
          resident: Promise.resolve(),
        };
      },
    );
    getArtifactFragment.mockImplementation((artifactId: string) => {
      events.push(`fragment:${artifactId}`);
      return artifactId === "artifact-a" ? firstFragment : null;
    });
    const { result } = renderHook(() => useEpicExportArtifacts(), {
      wrapper: makeWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        artifacts: [
          { id: "artifact-a", title: "First" },
          { id: "artifact-b", title: "Second" },
        ],
        format: "markdown",
        archive: true,
        archiveTitle: null,
        includeNested: false,
      }),
    ).rejects.toThrow("“Second” is still loading.");
    // THE REDDENING ONE. The first body must be RELEASED before the second is
    // materialized: a lease is what keeps a room resident, so retaining every
    // hold until the build made the whole selection hot at once - unbounded,
    // because the sidebar does not bound the selection. Sequential
    // materialization was never the property that mattered.
    expect(events).toEqual([
      "acquire:artifact-a",
      "fragment:artifact-a",
      "release:artifact-a",
      "acquire:artifact-b",
      "fragment:artifact-b",
      "release:artifact-b",
    ]);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    expect(createArtifactExport).not.toHaveBeenCalled();
  });

  it.each(["html", "canvas", "file"] as const)(
    "refuses a %s artifact before holding its body",
    async (kind) => {
      artifactRecords.current = {
        "artifact-a": { kind, title: "Landing Page" },
      };
      const { result } = renderHook(() => useEpicExportArtifacts(), {
        wrapper: makeWrapper(),
      });

      await expect(
        result.current.mutateAsync({
          artifacts: [{ id: "artifact-a", title: "Landing Page" }],
          format: "markdown",
          archive: false,
          archiveTitle: null,
          includeNested: false,
        }),
      ).rejects.toThrow(
        "Only Markdown artifacts can be exported as documents.",
      );
      expect(acquireResidentArtifactBodyLease).not.toHaveBeenCalled();
      expect(createArtifactExport).not.toHaveBeenCalled();
    },
  );

  it("still exports an artifact id the local store has not resolved yet", async () => {
    artifactRecords.current = {};
    const { result } = renderHook(() => useEpicExportArtifacts(), {
      wrapper: makeWrapper(),
    });

    await result.current.mutateAsync({
      artifacts: [{ id: "artifact-a", title: "Design" }],
      format: "markdown",
      archive: false,
      archiveTitle: null,
      includeNested: false,
    });

    expect(acquireResidentArtifactBodyLease).toHaveBeenCalledWith(
      "artifact-a",
      "immediate",
    );
    expect(createArtifactExport).toHaveBeenCalledTimes(1);
  });

  it("exports nested artifacts resolved from the tree at export time", async () => {
    artifactRecords.current = {
      spec: { kind: "spec", title: "Spec" },
      ticket: { kind: "ticket", title: "Ticket" },
    };
    serializeArtifactMarkdown.mockImplementation(() => "# body");
    saveBlobToDisk.mockResolvedValue({ name: "Spec.zip", path: null });
    const { result } = renderHook(() => useEpicExportArtifacts(), {
      wrapper: makeWrapper(),
    });
    // The child lands only after the hook rendered: the export must read the
    // tree when it runs, not a copy taken at render.
    artifactTree.current = {
      rootIds: ["spec"],
      childrenByParent: { spec: ["ticket"] },
      nodeById: { spec: { parentId: null }, ticket: { parentId: "spec" } },
    };

    await result.current.mutateAsync({
      artifacts: [{ id: "spec", title: "Spec" }],
      format: "pdf",
      archive: true,
      archiveTitle: "Spec",
      includeNested: true,
    });

    expect(acquireResidentArtifactBodyLease).toHaveBeenNthCalledWith(
      1,
      "spec",
      "immediate",
    );
    expect(acquireResidentArtifactBodyLease).toHaveBeenNthCalledWith(
      2,
      "ticket",
      "immediate",
    );
    expect(createArtifactExport).toHaveBeenCalledWith({
      artifacts: [
        { id: "spec", title: "Spec", parentId: null, markdown: "# body" },
        { id: "ticket", title: "Ticket", parentId: "spec", markdown: "# body" },
      ],
      format: "pdf",
      archive: true,
      archiveTitle: "Spec",
    });
    // One pick, two files: the event counts what the archive holds.
    expect(track).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.ArtifactExported,
      { format: "pdf", artifact_count: 2, include_nested: true },
    );
  });

  it("exports only the picked artifacts without nesting, laid out as the tree", async () => {
    artifactRecords.current = {
      spec: { kind: "spec", title: "Spec" },
      story: { kind: "story", title: "Story" },
      ticket: { kind: "ticket", title: "Ticket" },
    };
    artifactTree.current = {
      rootIds: ["spec"],
      childrenByParent: { spec: ["story"], story: ["ticket"] },
      nodeById: {
        spec: { parentId: null },
        story: { parentId: "spec" },
        ticket: { parentId: "story" },
      },
    };
    const { result } = renderHook(() => useEpicExportArtifacts(), {
      wrapper: makeWrapper(),
    });

    await result.current.mutateAsync({
      artifacts: [
        { id: "spec", title: "Spec" },
        { id: "ticket", title: "Ticket" },
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "Epic",
      includeNested: false,
    });

    expect(acquireResidentArtifactBodyLease).not.toHaveBeenCalledWith(
      "story",
      "immediate",
    );
    expect(createArtifactExport).toHaveBeenCalledWith({
      artifacts: [
        { id: "spec", title: "Spec", parentId: null, markdown: "# body" },
        { id: "ticket", title: "Ticket", parentId: "spec", markdown: "# body" },
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "Epic",
    });
  });

  it("names the parent of a nested artifact that cannot be loaded", async () => {
    artifactRecords.current = {
      spec: { kind: "spec", title: "Spec" },
      ticket: { kind: "ticket", title: "Ticket" },
    };
    artifactTree.current = {
      rootIds: ["spec"],
      childrenByParent: { spec: ["ticket"] },
      nodeById: { spec: { parentId: null }, ticket: { parentId: "spec" } },
    };
    getArtifactFragment.mockImplementation((artifactId: string) =>
      artifactId === "ticket" ? null : new Y.Doc().getXmlFragment("body"),
    );
    const { result } = renderHook(() => useEpicExportArtifacts(), {
      wrapper: makeWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        artifacts: [{ id: "spec", title: "Spec" }],
        format: "markdown",
        archive: true,
        archiveTitle: "Spec",
        includeNested: true,
      }),
    ).rejects.toThrow("“Ticket”, nested under “Spec”, is still loading.");
  });
});
