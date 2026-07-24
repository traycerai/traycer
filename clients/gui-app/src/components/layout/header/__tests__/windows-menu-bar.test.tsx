import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { WindowsMenuBar } from "@/components/layout/header/windows-menu-bar";
import type {
  DesktopMenuCommandPayload,
  DesktopRuntimePlatform,
  DesktopTopLevelMenuId,
} from "@/lib/windows/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

function buildHost(
  platform: DesktopRuntimePlatform,
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
      platform,
      onCommand: (_handler: (payload: DesktopMenuCommandPayload) => void) => ({
        dispose: () => undefined,
      }),
      openTopLevel,
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WindowsMenuBar", () => {
  it("shows every application menu and anchors native popup requests below the clicked label", async () => {
    const openTopLevel = vi.fn(() => Promise.resolve());
    const host = buildHost("win32", openTopLevel);
    render(
      <RunnerHostProvider runnerHost={host}>
        <WindowsMenuBar />
      </RunnerHostProvider>,
    );

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

  it("stays absent outside the Windows desktop shell", () => {
    const host = buildHost("darwin", () => Promise.resolve());
    render(
      <RunnerHostProvider runnerHost={host}>
        <WindowsMenuBar />
      </RunnerHostProvider>,
    );

    expect(
      screen.queryByRole("navigation", { name: "Application menu" }),
    ).toBeNull();
  });
});
