import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSupportBridge } from "@/lib/windows/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { AboutDetailsDialog } from "@/components/layout/dialogs/desktop/about-details-dialog";
import { createDesktopSupportBridgeStub } from "./support-bridge-stub";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

function unavailableSupport(): DesktopSupportBridge {
  return {
    ...createDesktopSupportBridgeStub(),
    getSnapshot: () =>
      Promise.reject(new Error("secret-token-should-never-render")),
  };
}

function readySupport(): DesktopSupportBridge {
  return {
    ...createDesktopSupportBridgeStub(),
    getSnapshot: () =>
      Promise.resolve({
        appName: "Traycer",
        appVersion: "1.1.8",
        supportEmail: "support@traycer.ai",
        privateDeliveryAvailable: true,
        platform: "darwin",
        arch: "arm64",
        versions: {
          electron: "42.7.1",
          chrome: "148.0.7778.280",
          node: "24.18.0",
        },
        host: {
          status: "ready" as const,
          version: "1.1.8",
          pid: 12257,
          hostId: "host-1",
        },
        logs: [],
        user: {
          status: "signed-in",
          userName: "Pranshu Gupta",
          email: "pranshu@traycer.ai",
        },
        links: [],
      }),
  };
}

describe("<AboutDetailsDialog />", () => {
  it("copies every detail row as label/value lines", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(
      <AboutDetailsDialog
        open
        onOpenChange={() => {}}
        support={readySupport()}
        openExternalLink={() => Promise.resolve()}
      />,
    );

    const copyButton = await screen.findByRole("button", {
      name: "Copy details",
    });
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith(
      [
        "Version: 1.1.8",
        "Signed In: Pranshu Gupta <pranshu@traycer.ai>",
        "Support: support@traycer.ai",
        "Platform: darwin arm64",
        "Electron: 42.7.1",
        "Chrome: 148.0.7778.280",
        "Node: 24.18.0",
        "Host: 1.1.8 (pid 12257)",
      ].join("\n"),
    );
    await screen.findByRole("button", { name: "Copied details" });
  });

  it("hides the copy action while details are unavailable", async () => {
    render(
      <AboutDetailsDialog
        open
        onOpenChange={() => {}}
        support={unavailableSupport()}
        openExternalLink={() => Promise.resolve()}
      />,
    );

    await waitFor(() => {
      screen.getByText("Could not load desktop details.");
    });
    expect(screen.queryByRole("button", { name: "Copy details" })).toBeNull();
  });

  it("gates the failed-snapshot report action on capability and never forwards the raw error", async () => {
    render(
      <AboutDetailsDialog
        open
        onOpenChange={() => {}}
        support={unavailableSupport()}
        openExternalLink={() => Promise.resolve()}
      />,
    );

    await waitFor(() => {
      screen.getByText("Could not load desktop details.");
    });
    expect(screen.queryByText(/secret-token-should-never-render/)).toBeNull();
    // Capability-gated off by default.
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
        source: "About Traycer",
      },
    });
  });

  it("gates the missing-support-bridge report action on capability", () => {
    render(
      <AboutDetailsDialog
        open
        onOpenChange={() => {}}
        support={null}
        openExternalLink={() => Promise.resolve()}
      />,
    );

    screen.getByText("Desktop support bridge unavailable.");
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));
    expect(useDesktopDialogStore.getState().reportIssueContext).toMatchObject({
      title: "Couldn't load desktop details",
      message: null,
      code: null,
      source: "About Traycer",
    });
  });
});
