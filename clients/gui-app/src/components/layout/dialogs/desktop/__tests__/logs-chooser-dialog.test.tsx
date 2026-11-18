import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DesktopSupportBridge,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { LogsChooserDialog } from "@/components/layout/dialogs/desktop/logs-chooser-dialog";
import { createDesktopSupportBridgeStub } from "./support-bridge-stub";

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
    privateDeliveryAvailable: true,
  };
}

function unavailableSupport(): DesktopSupportBridge {
  return {
    ...createDesktopSupportBridgeStub(),
    getSnapshot: () =>
      Promise.reject(new Error("secret-token-should-never-render")),
  };
}

function supportWithFailingTail(): DesktopSupportBridge {
  return {
    ...createDesktopSupportBridgeStub(),
    getSnapshot: () => Promise.resolve(readySnapshot()),
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
    // `findByRole`, not `getByRole`: the claim is that the action APPEARS
    // once the capability flips, not that it appears in the same synchronous
    // flush as the store write. Asserted synchronously this failed on CI's
    // gui-app shard 1/8 on two consecutive heads (a5d1a7f4, 5cd01e0f) - both
    // pushes that added test files and so re-shuffled the shard's file order
    // - while passing on rerun, and never reproducing locally (12 runs). The
    // mechanism is not pinned down (a worker-shared React flush deferred by an
    // earlier file is the leading suspect); a lost update would still fail
    // here, since `findByRole` times out rather than passes.
    fireEvent.click(
      await screen.findByRole("button", { name: "Report issue" }),
    );
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
    // Same shape as the arm above, for the same reason.
    fireEvent.click(
      await screen.findByRole("button", { name: "Report issue" }),
    );
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
