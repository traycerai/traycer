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

const acquireResidentArtifactBodyLease = vi.hoisted(() => vi.fn());
const getArtifactFragment = vi.hoisted(() => vi.fn());
const createArtifactExport = vi.hoisted(() => vi.fn());

vi.mock("@/lib/artifacts/artifact-export", () => ({
  createArtifactExport,
}));

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk: vi.fn(),
  openSavedFile: vi.fn(),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: {
      getState: () => ({
        acquireResidentArtifactBodyLease,
        getArtifactFragment,
      }),
    },
  }),
}));

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
    acquireResidentArtifactBodyLease.mockReset();
    getArtifactFragment.mockReset();
    createArtifactExport.mockReset();
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
      }),
    ).rejects.toThrow("“Design” is still loading.");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("takes artifact body leases sequentially and releases the first on a second failure", async () => {
    const firstFragment = new Y.Doc().getXmlFragment("first");
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const events: string[] = [];
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
      }),
    ).rejects.toThrow("“Second” is still loading.");
    expect(events).toEqual([
      "acquire:artifact-a",
      "fragment:artifact-a",
      "acquire:artifact-b",
      "fragment:artifact-b",
    ]);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    expect(createArtifactExport).not.toHaveBeenCalled();
  });
});
