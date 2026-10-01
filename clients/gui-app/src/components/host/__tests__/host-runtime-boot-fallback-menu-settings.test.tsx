import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import { HostRuntimeBootFallback } from "@/components/host/host-runtime-boot-fallback";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/**
 * The real `HostRuntimeBootFallback`, checking that a desktop menu
 * command and the card's own "Open settings" button reach two DISTINCT
 * callbacks. Fixture shape reused from `boot-desktop-menus.test.tsx`.
 */
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
}

function createMenuFixture(platform: "win32" | "linux"): MenuFixture {
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
    onChange: (_handler: () => void) => ({ dispose: () => undefined }),
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
  };
}

afterEach(() => {
  cleanup();
  useDesktopDialogStore.getState().close();
  vi.restoreAllMocks();
});

describe("<HostRuntimeBootFallback /> menu vs. card 'Open settings'", () => {
  for (const platform of ["win32", "linux"] as const) {
    it(`routes the ${platform} desktop menu's app.openSettings and the card's button to distinct callbacks`, () => {
      const fixture = createMenuFixture(platform);
      const onOpenSettings = vi.fn();
      const onMenuOpenSettings = vi.fn();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <RunnerHostProvider runnerHost={fixture.host}>
            <HostRuntimeBootFallback
              onConfigureShell={() => undefined}
              onOpenSettings={onOpenSettings}
              onMenuOpenSettings={onMenuOpenSettings}
            />
          </RunnerHostProvider>
        </QueryClientProvider>,
      );

      act(() => fixture.emit("app.openSettings"));
      expect(onMenuOpenSettings).toHaveBeenCalledTimes(1);
      expect(onOpenSettings).toHaveBeenCalledTimes(0);

      fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
      expect(onMenuOpenSettings).toHaveBeenCalledTimes(1);
    });
  }
});
