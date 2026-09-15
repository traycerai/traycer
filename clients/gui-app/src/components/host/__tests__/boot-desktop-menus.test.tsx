import type { ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import { BootDesktopMenus } from "@/components/host/boot-desktop-menus";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

vi.mock("@/components/layout/dialogs/desktop/logs-chooser-dialog", () => ({
  LogsChooserDialog: (props: { readonly open: boolean }): ReactNode =>
    props.open ? <div data-testid="boot-logs-dialog" /> : null,
}));

vi.mock("@/components/layout/dialogs/desktop/about-details-dialog", () => ({
  AboutDetailsDialog: (props: { readonly open: boolean }): ReactNode =>
    props.open ? <div data-testid="boot-about-dialog" /> : null,
}));

interface MenuFixture {
  readonly host: MockRunnerHost;
  readonly emit: (command: DesktopMenuCommandPayload["command"]) => void;
  readonly listenerCount: () => number;
}

function createMenuFixture(
  platform: "darwin" | "win32" | "linux",
): MenuFixture {
  const handlers = new Set<(payload: DesktopMenuCommandPayload) => void>();
  const menu = {
    platform,
    onCommand(handler: (payload: DesktopMenuCommandPayload) => void) {
      handlers.add(handler);
      return {
        dispose: () => {
          handlers.delete(handler);
        },
      };
    },
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
    openTopLevel: () => Promise.resolve(),
  };
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  Object.assign(host, { menu });
  return {
    host,
    emit: (command) => {
      for (const handler of handlers) {
        handler({ command, windowId: "window-1" });
      }
    },
    listenerCount: () => handlers.size,
  };
}

function renderBootMenus(
  fixture: MenuFixture,
  onOpenSettings: () => void,
): RenderResult {
  return render(
    <RunnerHostProvider runnerHost={fixture.host}>
      <BootDesktopMenus onOpenSettings={onOpenSettings} />
    </RunnerHostProvider>,
  );
}

afterEach(() => {
  cleanup();
  useDesktopDialogStore.getState().close();
  vi.restoreAllMocks();
});

describe("<BootDesktopMenus />", () => {
  for (const platform of ["linux", "win32"] as const) {
    it(`handles settings and support dialogs on ${platform} before HostRuntimeProvider mounts`, () => {
      const fixture = createMenuFixture(platform);
      const onOpenSettings = vi.fn();
      renderBootMenus(fixture, onOpenSettings);

      expect(fixture.listenerCount()).toBe(1);
      act(() => fixture.emit("app.openSettings"));
      expect(onOpenSettings).toHaveBeenCalledOnce();

      act(() => fixture.emit("app.openLogs"));
      expect(useDesktopDialogStore.getState().activeDialog).toBe("logs");
      expect(screen.queryByTestId("boot-logs-dialog")).not.toBeNull();

      act(() => fixture.emit("app.aboutDetails"));
      expect(useDesktopDialogStore.getState().activeDialog).toBe(
        "about-details",
      );
      expect(screen.queryByTestId("boot-about-dialog")).not.toBeNull();
    });

    it(`disposes the ${platform} boot subscription so a routed handoff cannot duplicate commands`, () => {
      const fixture = createMenuFixture(platform);
      const originalOpenLogs = useDesktopDialogStore.getState().openLogs;
      const openLogs = vi.fn(originalOpenLogs);
      useDesktopDialogStore.setState({ openLogs });
      const view = renderBootMenus(fixture, () => undefined);

      expect(fixture.listenerCount()).toBe(1);
      view.rerender(
        <RunnerHostProvider runnerHost={fixture.host}>
          <BootDesktopMenus onOpenSettings={() => undefined} />
        </RunnerHostProvider>,
      );
      expect(fixture.listenerCount()).toBe(1);

      act(() => fixture.emit("app.openLogs"));
      expect(openLogs).toHaveBeenCalledOnce();

      view.unmount();
      expect(fixture.listenerCount()).toBe(0);
      act(() => fixture.emit("app.openLogs"));
      expect(openLogs).toHaveBeenCalledOnce();
      useDesktopDialogStore.setState({ openLogs: originalOpenLogs });
    });
  }

  it("stays absent on macOS even when a menu bridge is available", () => {
    const fixture = createMenuFixture("darwin");
    renderBootMenus(fixture, () => undefined);

    expect(fixture.listenerCount()).toBe(0);
    expect(screen.queryByTestId("boot-logs-dialog")).toBeNull();
    expect(screen.queryByTestId("boot-about-dialog")).toBeNull();
  });
});
