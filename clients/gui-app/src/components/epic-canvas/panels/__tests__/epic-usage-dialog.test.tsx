import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { EpicUsageDialog } from "@/components/epic-canvas/panels/epic-usage-dialog";
import type { UsageChartOption } from "@/lib/usage-analytics/usage-chart-option";
import { getEChartsMockInstances } from "../../../../../__tests__/test-browser-apis";

/**
 * How many per-day points the mounted trend chart was actually given -
 * read from the option the mocked ECharts instance received, the area
 * chart's equivalent of counting the old per-day bar columns.
 */
function chartDayCount(): number {
  const option = getEChartsMockInstances().at(-1)?.options.at(-1);
  if (option === undefined) throw new Error("no ECharts option captured");
  const { xAxis } = option as UsageChartOption;
  const axis = Array.isArray(xAxis) ? xAxis[0] : xAxis;
  const data = axis !== undefined && "data" in axis ? axis.data : undefined;
  if (!Array.isArray(data)) throw new Error("x-axis carries no day labels");
  return data.length;
}

/**
 * The mounted trend chart's series names, in the last captured ECharts
 * option's series order - reads the same "last mocked instance, last
 * captured option" seam as {@link chartDayCount}, so a `chartGroupBy` switch
 * (which remounts the chart via its `key` prop) is picked up by re-reading
 * the newest mock instance rather than the original one.
 */
function chartSeriesNames(): readonly string[] {
  const option = getEChartsMockInstances().at(-1)?.options.at(-1);
  if (option === undefined) throw new Error("no ECharts option captured");
  const { series } = option as UsageChartOption;
  if (series === undefined) return [];
  const list = Array.isArray(series) ? series : [series];
  return list.map((entry) =>
    typeof entry.name === "string" ? entry.name : "",
  );
}

type UsageSummaryRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
  captureUsageExportImageBlob: vi.fn(),
  copyImageBlobToClipboard: vi.fn(),
  copyImageBlobPromiseToClipboard:
    vi.fn<(blobPromise: Promise<Blob>) => Promise<void>>(),
  saveBlobToDisk: vi.fn(),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTreeNode: (id: string) => ({ title: `Chat ${id}` }),
}));

// html-to-image's `toBlob` rasterises via a canvas that jsdom can't back -
// the hook's own capture step is stubbed here so these tests exercise the
// dialog's wiring (which node it resolves, what it hands off) rather than
// real rasterisation.
vi.mock("@/lib/usage-analytics/usage-export-image", () => ({
  USAGE_EXPORT_REGION_SELECTOR: "[data-usage-export-region]",
  captureUsageExportImageBlob: mocks.captureUsageExportImageBlob,
}));

vi.mock("@/lib/images/copy-image-to-clipboard", () => ({
  copyImageBlobToClipboard: mocks.copyImageBlobToClipboard,
  copyImageBlobPromiseToClipboard: mocks.copyImageBlobPromiseToClipboard,
}));

vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk: mocks.saveBlobToDisk,
  canOpenSavedFile: () => false,
  openSavedFile: vi.fn(),
}));

afterEach(() => {
  cleanup();
  mocks.openSettings.mockClear();
  mocks.captureUsageExportImageBlob.mockReset();
  mocks.copyImageBlobToClipboard.mockReset();
  mocks.copyImageBlobPromiseToClipboard.mockReset();
  mocks.saveBlobToDisk.mockReset();
});

const ZERO_PROVENANCE_SPLIT: UsageSummaryResponse["summary"]["totals"]["provenanceSplit"] =
  {
    providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
    modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
    unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  };

function usageSummaryResponse(): UsageSummaryResponse {
  return {
    servedBy: "cloud",
    summary: {
      window: {
        timezone: "UTC",
        windowDays: 30,
        // A real 30-day window whose last included day is the bucket's own
        // `2026-08-09` - `endAtExclusive` is the first instant OUTSIDE it,
        // which is what the chart's x-axis is anchored on.
        startAtInclusive: Date.parse("2026-07-11T00:00:00Z"),
        endAtExclusive: Date.parse("2026-08-10T00:00:00Z"),
      },
      epicId: "epic-1",
      chatId: null,
      totals: {
        factCount: 1,
        tokens: {
          uncachedInputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
        },
        knownCostUsd: 2.5,
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: "providerReported",
        provenanceSplit: ZERO_PROVENANCE_SPLIT,
      },
      buckets: [
        {
          day: "2026-08-09",
          harnessId: "claude",
          model: "claude-sonnet-5",
          factCount: 1,
          tokens: {
            uncachedInputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
          },
          knownCostUsd: 2.5,
          knownCacheSavingsUsd: 0,
          knownReasoningTokens: 0,
          costProvenance: "providerReported",
        },
      ],
      chatBuckets: [
        {
          chatId: "chat-1",
          epicId: "epic-1",
          factCount: 1,
          tokens: {
            uncachedInputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 50,
          },
          knownCostUsd: 2.5,
          knownCacheSavingsUsd: 0,
          knownReasoningTokens: 0,
          costProvenance: "providerReported",
        },
      ],
      hostBuckets: [],
      distinctEpicCount: 1,
      distinctChatCount: 1,
      outcomeBreakdown: {
        completed: 1,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: { measured: 1, partial: 0, absent: 0 },
      turnRows: null,
      turnRowsTruncated: false,
    },
    coverage: {
      pricedFactCount: 1,
      unpricedFactCount: 0,
      pricedTokenCount: 150,
      unpricedTokenCount: 0,
    },
  };
}

/**
 * `usageSummaryResponse()` plus a second same-day bucket from a different
 * harness/model, so the chart has something to actually regroup: switching
 * `chartGroupBy` folds the same two buckets by a different key and the
 * series names must change with it. `totals.factCount` tracks the bucket
 * count rather than staying pinned at the base fixture's `1`.
 */
function usageSummaryResponseWithTwoBuckets(): UsageSummaryResponse {
  const base = usageSummaryResponse();
  const secondBucket = {
    day: "2026-08-09",
    harnessId: "codex",
    model: "gpt-5.6-sol",
    factCount: 1,
    tokens: {
      uncachedInputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
    },
    knownCostUsd: 2.5,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
  } satisfies UsageSummaryResponse["summary"]["buckets"][number];
  return {
    ...base,
    summary: {
      ...base.summary,
      totals: {
        ...base.summary.totals,
        factCount: 2,
        knownCostUsd: 5,
      },
      buckets: [...base.summary.buckets, secondBucket],
    },
  };
}

function renderDialog(
  handler: (request: UsageSummaryRequest) => UsageSummaryResponse,
): {
  readonly onOpenChange: Mock<(open: boolean) => void>;
} {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: { "host.usage.summary": handler },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const onOpenChange = vi.fn();
  render(
    <EpicUsageDialog
      epicId="epic-1"
      client={client}
      open
      onOpenChange={onOpenChange}
    />,
    { wrapper },
  );
  return { onOpenChange };
}

describe("<EpicUsageDialog />", () => {
  it("defaults to the last 7 days", async () => {
    const handler = vi.fn(
      (_request: UsageSummaryRequest): UsageSummaryResponse =>
        usageSummaryResponse(),
    );
    renderDialog(handler);
    await screen.findByTestId("usage-cost-figure");

    expect(handler.mock.calls.at(0)?.at(0)).toMatchObject({
      windowDays: 7,
      window: undefined,
      epicId: "epic-1",
    });
    expect(
      screen.getByTestId("usage-window-7").getAttribute("data-state"),
    ).toBe("active");
  });

  it("renders the headline and the by-chat breakdown once open", async () => {
    renderDialog(usageSummaryResponse);
    const costFigure = await screen.findByTestId("usage-cost-figure");
    expect(within(costFigure).getByText("$2.50*")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("usage-chat-breakdown")).toBeTruthy();
    });
    expect(screen.getByText("Chat chat-1")).toBeTruthy();
  });

  it("closes and hands off to the Settings usage dashboard from 'View full usage'", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");

    await user.click(screen.getByTestId("epic-usage-view-full-dashboard"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.openSettings).toHaveBeenCalledWith({
      section: "usage",
      resetToGeneral: false,
    });
  });

  it("plots the requested response window", async () => {
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    await waitFor(() => {
      expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    });
    expect(chartDayCount()).toBe(30);
  });

  it("groups the chart by harness by default, and by model after switching the toggle", async () => {
    const user = userEvent.setup();
    renderDialog(usageSummaryResponseWithTwoBuckets);
    await screen.findByTestId("usage-cost-figure");
    await waitFor(() => {
      expect(screen.getByTestId("usage-daily-chart")).toBeTruthy();
    });
    expect(chartSeriesNames()).toEqual(["claude", "codex"]);

    await user.click(screen.getByTestId("usage-chart-groupby-model"));

    await waitFor(() => {
      expect(chartSeriesNames()).toEqual(["claude-sonnet-5", "gpt-5.6-sol"]);
    });
    // The harness split keeps its own harness-keyed scale: with the chart's
    // key space now models, a single shared scale would drop every split
    // row to the "Other" fallback token.
    const dot = screen
      .getByTestId("usage-harness-split-row-claude")
      .querySelector("span");
    expect(dot?.style.backgroundColor).toBe("var(--usage-harness-claude)");
  });

  it("routes an empty window to the empty state, offering only wider windows", async () => {
    const user = userEvent.setup();
    const handler = vi.fn(
      (_request: UsageSummaryRequest): UsageSummaryResponse => {
        const base = usageSummaryResponse();
        return {
          ...base,
          summary: {
            ...base.summary,
            totals: { ...base.summary.totals, factCount: 0, knownCostUsd: 0 },
            buckets: [],
            chatBuckets: [],
          },
        };
      },
    );
    renderDialog(handler);

    await screen.findByTestId("usage-dialog-empty");
    // The empty routing owns the state entirely: no hero, no breakdown, no
    // toggle - not a loaded layout full of zero-crumbs.
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
    expect(screen.queryByTestId("usage-chat-breakdown")).toBeNull();
    expect(screen.queryByTestId("usage-chart-groupby-harness")).toBeNull();
    expect(screen.queryByTestId("usage-chart-groupby-model")).toBeNull();

    // The default 7-day empty offers the two WIDER windows, and a chip
    // re-issues the request at its window.
    expect(screen.getByTestId("usage-empty-window-30")).toBeTruthy();
    await user.click(screen.getByTestId("usage-empty-window-90"));
    await waitFor(() => {
      expect(handler.mock.calls.at(-1)?.at(0)).toMatchObject({
        windowDays: 90,
      });
    });
    expect(
      screen.getByTestId("usage-window-90").getAttribute("data-state"),
    ).toBe("active");

    // A 90-day empty offers none - a chip that re-requests the current
    // window would be a broken control.
    await screen.findByTestId("usage-dialog-empty");
    expect(screen.queryByTestId("usage-empty-window-30")).toBeNull();
    expect(screen.queryByTestId("usage-empty-window-90")).toBeNull();
  });

  it("qualifies an empty local-plane read instead of claiming an account-wide zero", async () => {
    renderDialog((_request: UsageSummaryRequest): UsageSummaryResponse => {
      const base = usageSummaryResponse();
      return {
        ...base,
        // A local read speaks for THIS machine only, so its zero is not the
        // account's zero. The loaded branch carries that qualification on
        // the cost figure; routing to the empty state must not drop it.
        servedBy: "local",
        summary: {
          ...base.summary,
          totals: { ...base.summary.totals, factCount: 0, knownCostUsd: 0 },
          buckets: [],
          chatBuckets: [],
        },
      };
    });

    await screen.findByTestId("usage-dialog-empty");
    expect(
      screen.getByTestId("usage-served-by-local-note").textContent,
    ).toContain("This machine's usage only");
  });

  it("keeps the absent-usage disclaimer with the stat tiles", async () => {
    renderDialog((_request: UsageSummaryRequest): UsageSummaryResponse => {
      const base = usageSummaryResponse();
      return {
        ...base,
        summary: {
          ...base.summary,
          // Turns that reported nothing add a silent zero to every token sum
          // in the tiles, so the tiles cannot stand unqualified.
          usageCompletenessBreakdown: { measured: 1, partial: 0, absent: 2 },
        },
      };
    });

    const note = await screen.findByTestId("usage-stat-tiles-absent-note");
    expect(note.textContent).toContain("2 turns");
    // Paired with the tiles themselves, the way Settings pairs them.
    expect(
      within(screen.getByTestId("epic-usage-hero")).getByTestId(
        "usage-stat-tiles-absent-note",
      ),
    ).toBeTruthy();
  });

  it("renders the layout skeleton inside the constant frame while loading", async () => {
    renderDialog(usageSummaryResponse);

    // Synchronously after mount the query has not resolved: the body shows
    // the layout-mirroring skeleton, never a spinner line, while the frame
    // (window picker, footer) is already in place around it.
    expect(screen.getByTestId("usage-dialog-skeleton")).toBeTruthy();
    // The skeleton blocks are `aria-hidden`, so the state carries its name
    // in an sr-only status instead - visually a skeleton, audibly still
    // "Loading usage…", which the spinner line it replaced used to say.
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-testid")).toBe("usage-dialog-skeleton");
    expect(screen.getByText("Loading usage…").className).toContain("sr-only");
    expect(screen.getByTestId("usage-window-7")).toBeTruthy();
    expect(screen.getByTestId("epic-usage-view-full-dashboard")).toBeTruthy();

    // Every block must override the primitive's `bg-muted`: preset themes
    // define `--muted` identical to `--popover` (the dialog surface), which
    // made the whole skeleton render invisibly. A foreground-alpha fill is
    // the surface-independent guarantee.
    const blocks = status.querySelectorAll('[data-slot="skeleton"]');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.className).toContain("bg-foreground/10");
      expect(block.className).not.toContain("bg-muted");
    }

    await screen.findByTestId("usage-cost-figure");
    expect(screen.queryByTestId("usage-dialog-skeleton")).toBeNull();
  });

  it("keeps the fixed-frame and responsive structure classes on the shell", async () => {
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");

    // jsdom can't exercise container queries or viewport variants - the
    // structure and classes ARE the testable contract here; rendering-level
    // verification is the manual pass.
    const content = screen.getByTestId("epic-usage-dialog");
    expect(content.className).toContain("h-[min(88dvh,46rem)]");
    expect(content.className).toContain("sm:max-w-3xl");
    expect(content.className).toContain("max-[28rem]:bottom-0");
    expect(content.className).toContain("max-[28rem]:h-[94dvh]");
    expect(screen.getByTestId("usage-dialog-body").className).toContain(
      "@container",
    );
    expect(screen.getByTestId("epic-usage-hero").className).toContain(
      "@min-[40rem]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]",
    );
    // This dialog HAS a footer, and the footer is what absorbs the sheet's
    // home-indicator inset - the body must not double it.
    expect(screen.getByTestId("usage-dialog-body").className).not.toContain(
      "safe-area-inset-bottom",
    );
  });

  it("renders a retryable error card, never a silent fallback, when the RPC fails", async () => {
    renderDialog(() => {
      throw new Error("boom");
    });
    expect(await screen.findByTestId("usage-error-card")).toBeTruthy();
    expect(screen.queryByTestId("usage-cost-figure")).toBeNull();
    // The frame stays constant around the error fill.
    expect(screen.getByTestId("usage-window-7")).toBeTruthy();
    expect(screen.getByTestId("epic-usage-view-full-dashboard")).toBeTruthy();
  });

  it("enables the image-export footer buttons and renders the capture region once loaded", async () => {
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");

    const copyButton = screen.getByTestId("epic-usage-copy-image");
    const downloadButton = screen.getByTestId("epic-usage-download-image");
    expect(copyButton instanceof HTMLButtonElement && copyButton.disabled).toBe(
      false,
    );
    expect(
      downloadButton instanceof HTMLButtonElement && downloadButton.disabled,
    ).toBe(false);
    expect(screen.getByTestId("epic-usage-export-region")).toBeTruthy();
  });

  it("disables the image-export footer buttons when the window has no facts", async () => {
    const handler = vi.fn(
      (_request: UsageSummaryRequest): UsageSummaryResponse => {
        const base = usageSummaryResponse();
        return {
          ...base,
          summary: {
            ...base.summary,
            totals: { ...base.summary.totals, factCount: 0, knownCostUsd: 0 },
            buckets: [],
            chatBuckets: [],
          },
        };
      },
    );
    renderDialog(handler);

    await screen.findByTestId("usage-dialog-empty");
    const copyButton = screen.getByTestId("epic-usage-copy-image");
    const downloadButton = screen.getByTestId("epic-usage-download-image");
    expect(copyButton instanceof HTMLButtonElement && copyButton.disabled).toBe(
      true,
    );
    expect(
      downloadButton instanceof HTMLButtonElement && downloadButton.disabled,
    ).toBe(true);
  });

  it("captures the export region and copies it to the clipboard from 'Copy image'", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    mocks.captureUsageExportImageBlob.mockResolvedValue(blob);
    mocks.copyImageBlobPromiseToClipboard.mockResolvedValue(undefined);
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    const exportRegion = screen.getByTestId("epic-usage-export-region");

    await user.click(screen.getByTestId("epic-usage-copy-image"));

    await waitFor(() => {
      expect(mocks.copyImageBlobPromiseToClipboard).toHaveBeenCalledTimes(1);
    });
    const [captured] = mocks.copyImageBlobPromiseToClipboard.mock.calls[0];
    await expect(captured).resolves.toBe(blob);
    expect(mocks.captureUsageExportImageBlob).toHaveBeenCalledWith({
      region: exportRegion,
      heading: "Usage",
      subheading: "Cost and token usage for this task.",
    });
    expect(mocks.saveBlobToDisk).not.toHaveBeenCalled();
  });

  it("hands the pending capture to the clipboard on click, before it resolves", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    let resolveCapture: (value: Blob) => void = () => undefined;
    mocks.captureUsageExportImageBlob.mockReturnValue(
      new Promise<Blob>((resolve) => {
        resolveCapture = resolve;
      }),
    );
    mocks.copyImageBlobPromiseToClipboard.mockResolvedValue(undefined);
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");

    await user.click(screen.getByTestId("epic-usage-copy-image"));

    // The clipboard call is what has to happen inside the click's user
    // activation, so it must already have been made while the capture it was
    // handed is still pending - not after the blob lands.
    expect(mocks.copyImageBlobPromiseToClipboard).toHaveBeenCalledTimes(1);
    const [captured] = mocks.copyImageBlobPromiseToClipboard.mock.calls[0];
    resolveCapture(blob);
    await expect(captured).resolves.toBe(blob);
  });

  it("disables the download button too while a copy export is in flight", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    let resolveCapture: (value: Blob) => void = () => undefined;
    mocks.captureUsageExportImageBlob.mockReturnValue(
      new Promise<Blob>((resolve) => {
        resolveCapture = resolve;
      }),
    );
    mocks.copyImageBlobPromiseToClipboard.mockImplementation(
      async (blobPromise) => {
        await blobPromise;
      },
    );
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");

    await user.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Copy image" }),
    );

    // A capture is a full-region rasterisation, so the two legs share one
    // mutation: while the copy runs, DOWNLOAD is disabled too - not just the
    // button that was pressed.
    const downloadButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Download image",
    });
    await waitFor(() => {
      expect(downloadButton.disabled).toBe(true);
    });
    expect(mocks.captureUsageExportImageBlob).toHaveBeenCalledTimes(1);

    resolveCapture(blob);

    await waitFor(() => {
      expect(downloadButton.disabled).toBe(false);
    });
  });

  it("captures the export region and saves it to disk from 'Download image'", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    mocks.captureUsageExportImageBlob.mockResolvedValue(blob);
    mocks.saveBlobToDisk.mockResolvedValue({
      name: "traycer-usage-7d.png",
      path: null,
    });
    renderDialog(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    const exportRegion = screen.getByTestId("epic-usage-export-region");

    await user.click(screen.getByTestId("epic-usage-download-image"));

    await waitFor(() => {
      expect(mocks.saveBlobToDisk).toHaveBeenCalledWith(
        blob,
        "traycer-usage-7d.png",
      );
    });
    expect(mocks.captureUsageExportImageBlob).toHaveBeenCalledWith({
      region: exportRegion,
      heading: "Usage",
      subheading: "Cost and token usage for this task.",
    });
    expect(mocks.copyImageBlobPromiseToClipboard).not.toHaveBeenCalled();
  });
});
