import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
  appLogger: { errorSummary: vi.fn() },
}));

vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: vi.fn(),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: {
      getState: () => ({ getArtifactFragment: vi.fn() }),
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
});
