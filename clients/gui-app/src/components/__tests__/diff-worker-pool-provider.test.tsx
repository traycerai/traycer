import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiffWorkerPoolProvider } from "@/components/diff-worker-pool-provider";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import type { ResolvedThemeContextValue } from "@/providers/use-resolved-theme";

const mockSetRenderOptions = vi.fn();

vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="worker-pool-provider">{children}</div>
  ),
  useWorkerPool: () => ({
    setRenderOptions: mockSetRenderOptions,
  }),
}));

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: vi.fn(() => ({})),
}));

describe("DiffWorkerPoolProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetRenderOptions.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("renders children", () => {
    const themeValue: ResolvedThemeContextValue = {
      resolvedTheme: "light",
      themePreset: "neutral",
    };

    render(
      <ResolvedThemeContext.Provider value={themeValue}>
        <DiffWorkerPoolProvider>
          <div data-testid="test-child">Child content</div>
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(screen.getByTestId("test-child")).toBeDefined();
    expect(screen.getByText("Child content")).toBeDefined();
  });

  it("mounts WorkerPoolContextProvider", () => {
    const themeValue: ResolvedThemeContextValue = {
      resolvedTheme: "light",
      themePreset: "neutral",
    };

    render(
      <ResolvedThemeContext.Provider value={themeValue}>
        <DiffWorkerPoolProvider>
          <div>Test</div>
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(screen.getByTestId("worker-pool-provider")).toBeDefined();
  });

  it("calls setRenderOptions with light theme", () => {
    mockSetRenderOptions.mockClear();

    const themeValue: ResolvedThemeContextValue = {
      resolvedTheme: "light",
      themePreset: "neutral",
    };

    render(
      <ResolvedThemeContext.Provider value={themeValue}>
        <DiffWorkerPoolProvider>
          <div>Test</div>
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(mockSetRenderOptions).toHaveBeenCalledWith({
      theme: "pierre-light",
    });
  });

  it("calls setRenderOptions with dark theme", () => {
    mockSetRenderOptions.mockClear();

    const themeValue: ResolvedThemeContextValue = {
      resolvedTheme: "dark",
      themePreset: "neutral",
    };

    render(
      <ResolvedThemeContext.Provider value={themeValue}>
        <DiffWorkerPoolProvider>
          <div>Test</div>
        </DiffWorkerPoolProvider>
      </ResolvedThemeContext.Provider>,
    );

    expect(mockSetRenderOptions).toHaveBeenCalledWith({
      theme: "pierre-dark",
    });
  });
});
