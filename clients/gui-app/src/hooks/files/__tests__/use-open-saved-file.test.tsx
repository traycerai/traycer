import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useOpenSavedFile } from "../use-open-saved-file";

const mocks = vi.hoisted(() => ({
  openSavedFile: vi.fn<
    (saved: { name: string; path: string | null }) => Promise<void>
  >(() => Promise.resolve()),
  toastFromRunnerError: vi.fn(),
  errorSummary: vi.fn(),
}));

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  openSavedFile: mocks.openSavedFile,
}));

vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: mocks.toastFromRunnerError,
}));

vi.mock("@/lib/logger", () => ({
  appLogger: { errorSummary: mocks.errorSummary },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return function OpenSavedFileWrapper(props: {
    readonly children: ReactNode;
  }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

describe("useOpenSavedFile", () => {
  it("opens the saved file through the desktop bridge", async () => {
    const { result } = renderHook(useOpenSavedFile, {
      wrapper: createWrapper(),
    });
    const saved = { name: "a.md", path: "/tmp/x/a.md" };

    await result.current.mutateAsync(saved);

    expect(mocks.openSavedFile.mock.calls[0]?.[0]).toEqual(saved);
  });

  it("maps runner bridge failures onto toastFromRunnerError", async () => {
    const failure = new Error("gone");
    mocks.openSavedFile.mockRejectedValueOnce(failure);
    const { result } = renderHook(useOpenSavedFile, {
      wrapper: createWrapper(),
    });
    const saved = { name: "a.md", path: "/tmp/x/a.md" };

    await expect(result.current.mutateAsync(saved)).rejects.toThrow("gone");
    expect(mocks.errorSummary).toHaveBeenCalledTimes(1);
    expect(mocks.toastFromRunnerError).toHaveBeenCalledWith(
      failure,
      "Could not open a.md",
    );
  });
});
