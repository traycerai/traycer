import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { WindowsMenuBar } from "@/components/layout/header/windows-menu-bar";
import type {
  DesktopMenuCommandPayload,
  DesktopTopLevelMenuId,
} from "@/lib/windows/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const { isWindowsMock } = vi.hoisted(() => ({
  isWindowsMock: vi.fn((): boolean => true),
}));

vi.mock("@/lib/keybindings/platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/platform")>();
  return { ...actual, isWindows: isWindowsMock };
});

function buildHost(
  openTopLevel: (
    menuId: DesktopTopLevelMenuId,
    anchorX: number,
    anchorY: number,
  ) => Promise<void>,
) {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return Object.assign(host, {
    menu: {
      onCommand: (_handler: (payload: DesktopMenuCommandPayload) => void) => ({
        dispose: () => undefined,
      }),
      openTopLevel,
    },
  });
}

// The popup goes through a TanStack mutation, so the bar needs a QueryClient
// ancestor - present app-wide in production, supplied here per render.
function renderMenuBar(host: IRunnerHost) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostProvider runnerHost={host}>
        <WindowsMenuBar />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  isWindowsMock.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WindowsMenuBar", () => {
  it("shows every application menu and anchors native popup requests below the clicked label", async () => {
    const openTopLevel = vi.fn(() => Promise.resolve());
    const host = buildHost(openTopLevel);
    renderMenuBar(host);

    expect(
      screen.getAllByRole("button").map((item) => item.textContent),
    ).toEqual(["File", "Edit", "View", "Window", "Help"]);
    const help = screen.getByRole("button", { name: "Help" });
    vi.spyOn(help, "getBoundingClientRect").mockReturnValue(
      new DOMRect(120, 4, 40, 32),
    );

    fireEvent.click(help);

    await waitFor(() => {
      expect(openTopLevel).toHaveBeenCalledWith("help", 120, 36);
    });
  });

  it("opens the matching menu when its Alt access key is pressed", async () => {
    const openTopLevel = vi.fn(() => Promise.resolve());
    const host = buildHost(openTopLevel);
    renderMenuBar(host);
    const view = screen.getByRole("button", { name: "View" });
    vi.spyOn(view, "getBoundingClientRect").mockReturnValue(
      new DOMRect(60, 4, 40, 32),
    );

    fireEvent.keyDown(document.body, { key: "v", altKey: true });

    await waitFor(() => {
      expect(openTopLevel).toHaveBeenCalledWith("view", 60, 36);
    });
  });

  it("underlines each access key while Alt is held", () => {
    const host = buildHost(() => Promise.resolve());
    renderMenuBar(host);
    const file = screen.getByRole("button", { name: "File" });
    expect(file.querySelector("span.underline")).toBeNull();

    fireEvent.keyDown(document.body, { key: "Alt", altKey: true });
    expect(file.querySelector("span.underline")?.textContent).toBe("F");

    fireEvent.keyUp(document.body, { key: "Alt" });
    expect(file.querySelector("span.underline")).toBeNull();
  });

  it("stays absent outside the Windows desktop shell", () => {
    isWindowsMock.mockReturnValue(false);
    const host = buildHost(() => Promise.resolve());
    renderMenuBar(host);

    expect(
      screen.queryByRole("navigation", { name: "Application menu" }),
    ).toBeNull();
  });

  it("stays absent when no desktop menu bridge is present", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    renderMenuBar(host);

    expect(
      screen.queryByRole("navigation", { name: "Application menu" }),
    ).toBeNull();
  });
});
