import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DesktopSupportBridge,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { LogsChooserDialog } from "@/components/layout/dialogs/desktop/logs-chooser-dialog";

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

function readySnapshot(): DesktopSupportSnapshot {
  return {
    appName: "Traycer",
    appVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    user: { status: "signed-out", userName: null, email: null },
    versions: { electron: "1", chrome: "1", node: "1" },
    host: { status: "ready", version: "1", pid: 1, hostId: "host-1" },
    logs: [{ target: "desktop", label: "Desktop", path: "/tmp/desktop.log" }],
    links: [],
    supportEmail: "support@traycer.ai",
  };
}

function unavailableSupport(): DesktopSupportBridge {
  return {
    getSnapshot: () =>
      Promise.reject(new Error("secret-token-should-never-render")),
    revealLog: vi.fn(),
    submitReport: vi.fn(),
    tailLog: vi.fn(),
  };
}

function supportWithFailingTail(): DesktopSupportBridge {
  return {
    getSnapshot: () => Promise.resolve(readySnapshot()),
    revealLog: vi.fn(),
    submitReport: vi.fn(),
    tailLog: () =>
      Promise.reject(new Error("secret-log-path-should-never-render")),
  };
}

function renderDialog(support: DesktopSupportBridge | null): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  );
  render(
    <Wrapper>
      <LogsChooserDialog open onOpenChange={() => {}} support={support} />
    </Wrapper>,
  );
}

describe("<LogsChooserDialog />", () => {
  it("gates the failed-snapshot report action on capability and never forwards the raw error", async () => {
    renderDialog(unavailableSupport());

    await waitFor(() => {
      screen.getByText("Could not load desktop details.");
    });
    expect(screen.queryByText(/secret-token-should-never-render/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load desktop details",
        message: null,
        code: null,
        source: "Logs",
      },
    });
  });

  it("gates the failed-log-tail report action on capability and never forwards the raw tail error", async () => {
    renderDialog(supportWithFailingTail());

    await waitFor(() => {
      screen.getByText("Desktop");
    });
    fireEvent.click(screen.getByRole("button", { name: /Desktop/ }));

    await waitFor(() => {
      screen.getByText("Could not load log output.");
    });
    expect(
      screen.queryByText(/secret-log-path-should-never-render/),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load log output",
        message: null,
        code: null,
        source: "Logs",
      },
    });
  });
});
