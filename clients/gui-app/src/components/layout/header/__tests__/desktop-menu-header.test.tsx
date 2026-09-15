import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import { DesktopMenuHeader } from "@/components/layout/header/desktop-menu-header";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

type DesktopPlatform = "darwin" | "win32" | "linux";

function createDesktopHost(platform: DesktopPlatform): MockRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  Object.assign(host, {
    menu: {
      platform,
      onCommand: (_handler: (payload: DesktopMenuCommandPayload) => void) => ({
        dispose: () => undefined,
      }),
      getSnapshot: () =>
        Promise.resolve({
          revision: 1,
          menus: [
            { id: "file", label: "File", items: [] },
            { id: "edit", label: "Edit", items: [] },
            { id: "view", label: "View", items: [] },
            { id: "window", label: "Window", items: [] },
            { id: "help", label: "Help", items: [] },
          ],
        }),
      executeItem: () => Promise.resolve(),
      onChange: (_handler: () => void) => ({ dispose: () => undefined }),
      openTopLevel: () => Promise.resolve(),
    },
  });
  return host;
}

function renderHeader(host: MockRunnerHost): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostProvider runnerHost={host}>
        <DesktopMenuHeader />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useTitleBarDragStore
    .getState()
    .setSuppressed("desktop-menu-header-test", false);
});

for (const platform of ["win32", "linux"] as const) {
  it(`renders one shared menu row for ${platform}`, () => {
    renderHeader(createDesktopHost(platform));

    const header = screen.getByTestId("desktop-menu-header");
    expect(header.className).toContain("h-10");
    expect(header.className).toContain("wco:pl-[env(titlebar-area-x,0px)]");
    expect(header.className).toContain(
      "wco:pr-[max(12px,calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+12px))]",
    );
    expect(
      screen.getAllByRole("navigation", { name: "Application menu" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
  });
}

it("drops the drag region while a title-bar overlay is open", () => {
  renderHeader(createDesktopHost("linux"));
  const header = screen.getByTestId("desktop-menu-header");
  expect(header.className).toContain("[-webkit-app-region:drag]");

  act(() => {
    useTitleBarDragStore
      .getState()
      .setSuppressed("desktop-menu-header-test", true);
  });
  expect(header.className).toContain("[-webkit-app-region:no-drag]");
});

it("reserves the same h-10 boot slot when desktop menus are inactive", () => {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <RunnerHostProvider runnerHost={createDesktopHost("darwin")}>
        <DesktopMenuHeader />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  const reservation = container.querySelector('[aria-hidden="true"]');
  expect(reservation).not.toBeNull();
  expect(reservation?.className).toContain("h-10");
  expect(
    screen.queryByRole("navigation", { name: "Application menu" }),
  ).toBeNull();
});

it("reserves a boot slot in a browser tree without a host bridge", () => {
  const { container } = render(<DesktopMenuHeader />);
  const reservation = container.querySelector('[aria-hidden="true"]');
  expect(reservation).not.toBeNull();
  expect(reservation?.className).toContain("h-10");
});
