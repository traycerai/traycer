import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "../tile-controller";
import { useElectronTabChrome } from "../use-electron-tile-chrome";
import type {
  BrowserViewDownloadCancel,
  BrowserViewDownloadChange,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const TILE_A: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "session-1",
};

const TILE_B: BrowserViewTileKey = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-2",
  pageSessionId: "session-2",
};

const BASE_DOWNLOAD: BrowserViewDownloadChange = {
  ...TILE_A,
  downloadId: "download-base",
  url: "https://example.com/report.zip",
  filename: "report.zip",
  mimeType: "application/octet-stream",
  totalBytes: 100,
  receivedBytes: 0,
  state: "progressing",
  dangerType: null,
  canCancel: true,
};

class DownloadEventBridge extends FakeBrowserViewBridge {
  readonly cancelDownloadCalls: BrowserViewDownloadCancel[] = [];
  private readonly handlers = new Set<
    (change: BrowserViewDownloadChange) => void
  >();

  override onDownloadChange(
    handler: (change: BrowserViewDownloadChange) => void,
  ): { dispose: () => void } {
    this.handlers.add(handler);
    return { dispose: () => this.handlers.delete(handler) };
  }

  override cancelDownload(input: BrowserViewDownloadCancel): Promise<void> {
    this.cancelDownloadCalls.push(input);
    return Promise.resolve();
  }

  emitDownload(change: BrowserViewDownloadChange): void {
    this.handlers.forEach((handler) => handler(change));
  }
}

function download(
  input: Partial<BrowserViewDownloadChange> &
    Pick<
      BrowserViewDownloadChange,
      "downloadId" | "state" | "receivedBytes" | "canCancel"
    >,
): BrowserViewDownloadChange {
  const change = { ...BASE_DOWNLOAD, ...input };
  return { ...change, url: `https://example.com/${change.filename}` };
}

function DownloadToastHook(props: {
  readonly bridge: DownloadEventBridge;
  readonly tileKey: BrowserViewTileKey;
}) {
  useElectronTabChrome({
    profile: "primary",
    control: () => Promise.resolve(),
    surfaceServices: props.bridge,
    tileKey: props.tileKey,
    initialUrl: "https://example.com/",
    capabilities: PRIMARY_TILE_CHROME_CAPABILITIES,
    annotation: null,
    statusUrl: "",
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    onAttemptedUrl: () => undefined,
  });
  return null;
}

function DownloadToastApp(props: {
  readonly bridge: DownloadEventBridge;
  readonly tileKey: BrowserViewTileKey;
}) {
  return (
    <>
      <DownloadToastHook bridge={props.bridge} tileKey={props.tileKey} />
      <Toaster />
    </>
  );
}

async function emitDownload(
  bridge: DownloadEventBridge,
  change: BrowserViewDownloadChange,
): Promise<void> {
  await act(async () => {
    bridge.emitDownload(change);
    await vi.advanceTimersByTimeAsync(1);
  });
}

async function advanceTimers(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function toastRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-sonner-toast]"),
  );
}

function toastRowContaining(text: string): HTMLElement {
  const row = toastRows().find((candidate) =>
    candidate.textContent.includes(text),
  );
  if (row === undefined) throw new Error(`Missing toast containing: ${text}`);
  return row;
}

describe("browser download toasts", () => {
  afterEach(async () => {
    toast.dismiss();
    await advanceTimers(1000);
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps progress past four seconds and separates cancel from close", async () => {
    vi.useFakeTimers();
    const bridge = new DownloadEventBridge({});
    render(<DownloadToastApp bridge={bridge} tileKey={TILE_A} />);

    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "progressing",
        receivedBytes: 50,
        canCancel: true,
      }),
    );
    await advanceTimers(5000);

    const progress = toastRowContaining("50 B of 100 B");
    fireEvent.click(within(progress).getByRole("button", { name: "Cancel" }));
    expect(bridge.cancelDownloadCalls).toEqual([{ downloadId: "download-1" }]);
    expect(toastRowContaining("50 B of 100 B")).toBeTruthy();

    fireEvent.click(
      within(toastRowContaining("50 B of 100 B")).getByRole("button", {
        name: "Close toast",
      }),
    );
    await advanceTimers(500);
    expect(screen.queryByText("50 B of 100 B")).toBeNull();
    expect(bridge.cancelDownloadCalls).toHaveLength(1);

    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "progressing",
        receivedBytes: 75,
        canCancel: true,
      }),
    );
    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "completed",
        receivedBytes: 100,
        canCancel: false,
      }),
    );
    expect(toastRows()).toHaveLength(0);
  });

  it("replaces by download ID, filters by tile, and expires terminal toasts", async () => {
    vi.useFakeTimers();
    const bridge = new DownloadEventBridge({});
    render(<DownloadToastApp bridge={bridge} tileKey={TILE_A} />);

    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "progressing",
        receivedBytes: 50,
        canCancel: true,
      }),
    );
    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "progressing",
        receivedBytes: 75,
        canCancel: true,
      }),
    );
    await emitDownload(
      bridge,
      download({
        downloadId: "download-2",
        state: "progressing",
        receivedBytes: 20,
        canCancel: true,
      }),
    );
    await emitDownload(
      bridge,
      download({
        ...TILE_B,
        downloadId: "other-tile",
        filename: "ignored.zip",
        state: "completed",
        receivedBytes: 100,
        canCancel: false,
      }),
    );

    expect(toastRows()).toHaveLength(2);
    expect(screen.getAllByText("report.zip")).toHaveLength(2);
    expect(screen.queryByText("50 B of 100 B")).toBeNull();
    expect(screen.getByText("75 B of 100 B")).toBeTruthy();
    expect(screen.queryByText("ignored.zip")).toBeNull();

    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "completed",
        receivedBytes: 100,
        canCancel: false,
      }),
    );
    const completed = toastRowContaining("Download complete");
    expect(
      completed.querySelector("[data-icon] .lucide-circle-check"),
    ).not.toBeNull();
    expect(
      completed.querySelector('[data-icon] span[aria-hidden="true"]'),
    ).toBeNull();
    expect(
      within(completed).queryByRole("button", { name: "Cancel" }),
    ).toBeNull();

    await emitDownload(
      bridge,
      download({
        downloadId: "download-2",
        state: "cancelled",
        receivedBytes: 20,
        canCancel: false,
      }),
    );
    const cancelled = toastRowContaining("Download cancelled");
    fireEvent.click(
      within(cancelled).getByRole("button", { name: "Close toast" }),
    );
    await advanceTimers(500);
    expect(screen.queryByText("Download cancelled")).toBeNull();
    await advanceTimers(2998);
    expect(screen.getByText("Download complete")).toBeTruthy();
    await advanceTimers(1001);
    expect(toastRows()).toHaveLength(0);
  });

  it("keeps cancellable interruptions active and cleans up only active tile toasts", async () => {
    vi.useFakeTimers();
    const bridge = new DownloadEventBridge({});
    const view = render(<DownloadToastApp bridge={bridge} tileKey={TILE_A} />);
    await act(async () => {
      toast.info("Unrelated notification", { duration: Infinity });
      await vi.advanceTimersByTimeAsync(1);
    });

    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "interrupted",
        receivedBytes: 50,
        canCancel: true,
      }),
    );
    await advanceTimers(5000);
    const activeInterruption = toastRowContaining("Download interrupted");
    expect(
      within(activeInterruption).getByRole("button", { name: "Cancel" }),
    ).toBeTruthy();

    await emitDownload(
      bridge,
      download({
        downloadId: "download-1",
        state: "interrupted",
        receivedBytes: 50,
        canCancel: false,
      }),
    );
    const finishedInterruption = toastRowContaining("Download interrupted");
    expect(
      finishedInterruption.querySelector("[data-icon] .lucide-triangle-alert"),
    ).not.toBeNull();
    expect(
      within(finishedInterruption).queryByRole("button", { name: "Cancel" }),
    ).toBeNull();

    await emitDownload(
      bridge,
      download({
        downloadId: "download-2",
        filename: "archive.zip",
        state: "progressing",
        receivedBytes: 10,
        canCancel: true,
      }),
    );
    view.rerender(<Toaster />);
    await advanceTimers(500);

    expect(screen.queryByText("archive.zip")).toBeNull();
    expect(screen.getByText("Download interrupted")).toBeTruthy();
    expect(screen.getByText("Unrelated notification")).toBeTruthy();

    await advanceTimers(4500);
    expect(screen.queryByText("Download interrupted")).toBeNull();
    expect(screen.getByText("Unrelated notification")).toBeTruthy();
  });
});
