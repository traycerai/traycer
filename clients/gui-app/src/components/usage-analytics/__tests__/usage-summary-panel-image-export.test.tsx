import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageSummaryPanel } from "@/components/usage-analytics/usage-summary-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { formatDateRangeLabel } from "@/lib/usage-analytics/format-metric-value";
import { lastNCalendarDays } from "@/lib/usage-analytics/day-window";

type UsageSummaryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;
type UsageSummaryRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.usage.summary"
>;

const mocks = vi.hoisted(() => ({
  captureUsageExportImageBlob: vi.fn(),
  copyImageBlobToClipboard: vi.fn(),
  copyImageBlobPromiseToClipboard:
    vi.fn<(blobPromise: Promise<Blob>) => Promise<void>>(),
  saveBlobToDisk: vi.fn(),
}));

// html-to-image's `toBlob` rasterises via a canvas that jsdom can't back -
// the hook's own capture step is stubbed here so these tests exercise the
// panel's wiring (which node it resolves, what it hands off) rather than
// real rasterisation. Mirrors the mocking pattern in
// `epic-usage-dialog.test.tsx`.
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
  // Browser-runtime shape: the picker never reports a path, so the saved
  // toast has no "Open file" action to offer.
  canOpenSavedFile: () => false,
  openSavedFile: vi.fn(),
}));

afterEach(() => {
  cleanup();
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

const RESPONSE_WINDOW = {
  timezone: "UTC",
  windowDays: 30,
  startAtInclusive: Date.parse("2026-07-11T00:00:00Z"),
  endAtExclusive: Date.parse("2026-08-10T00:00:00Z"),
} satisfies UsageSummaryResponse["summary"]["window"];

// The panel builds its subheading from the response's own window (see
// `daysForResponse`/`formatDateRangeLabel` in `usage-summary-panel.tsx`) -
// computed here with the same helpers rather than hand-typed, so the
// assertion tracks the panel's actual label instead of a guess at its format.
const EXPECTED_DATE_RANGE = formatDateRangeLabel(
  lastNCalendarDays(
    RESPONSE_WINDOW.windowDays,
    RESPONSE_WINDOW.timezone,
    RESPONSE_WINDOW.endAtExclusive - 1,
  ),
);

// The metric is part of the subheading because its toggle is outside the
// capture region. The separator and the metric wording are asserted literally
// - this is the text a reader of the exported PNG sees.
const EXPECTED_SUBHEADING = `${EXPECTED_DATE_RANGE} · Cost`;

function usageSummaryResponse(): UsageSummaryResponse {
  return {
    servedBy: "cloud",
    summary: {
      window: RESPONSE_WINDOW,
      epicId: null,
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
      chatBuckets: [],
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

function renderPanel(
  handler: (request: UsageSummaryRequest) => UsageSummaryResponse,
): void {
  // A client no longer binds an active host of its own: the host row lives in
  // `host-connection-registry` and a consumer addresses one host through a
  // REQUESTER, which is a routing view over this spine rather than a second
  // client. Matches `usage-summary-panel-host-scope.test.tsx`.
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    // Load-bearing, not boilerplate: a requester resolves its entry through
    // this at property-access time, and `captureAuthority` refuses a routed
    // entry that no longer matches the live directory. Omit it and every
    // request is silently never issued - the panel renders but no figure ever
    // arrives.
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
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  render(
    <UsageSummaryPanel
      client={client}
      hostNames={new Map()}
      currentHostId={mockLocalHostEntry.hostId}
    />,
    { wrapper },
  );
}

describe("<UsageSummaryPanel /> image export", () => {
  it("enables both export buttons and renders the capture region once loaded", async () => {
    renderPanel(usageSummaryResponse);
    // Both reads, not just the primary one: `exportReady` also waits for the
    // activity lane to settle, so waiting on the cost figure alone would
    // assert on a pass where the buttons are still legitimately disabled.
    await screen.findByTestId("usage-cost-figure");
    await screen.findByTestId("usage-activity-section");

    const copyButton = screen.getByTestId("usage-copy-image");
    const downloadButton = screen.getByTestId("usage-download-image");
    expect(copyButton instanceof HTMLButtonElement && copyButton.disabled).toBe(
      false,
    );
    expect(
      downloadButton instanceof HTMLButtonElement && downloadButton.disabled,
    ).toBe(false);
    expect(screen.getByTestId("usage-export-region")).toBeTruthy();
  });

  it("disables both export buttons until the query resolves, then enables them", async () => {
    renderPanel(usageSummaryResponse);

    // Synchronously after mount the query has not resolved yet, so
    // `query.data` is still `undefined` - `exportReady` gates on exactly
    // that (not on fact count), and the buttons must not race ahead of it.
    const copyButton = screen.getByTestId("usage-copy-image");
    const downloadButton = screen.getByTestId("usage-download-image");
    expect(copyButton instanceof HTMLButtonElement && copyButton.disabled).toBe(
      true,
    );
    expect(
      downloadButton instanceof HTMLButtonElement && downloadButton.disabled,
    ).toBe(true);

    await screen.findByTestId("usage-cost-figure");
    await screen.findByTestId("usage-activity-section");
    expect(copyButton instanceof HTMLButtonElement && copyButton.disabled).toBe(
      false,
    );
    expect(
      downloadButton instanceof HTMLButtonElement && downloadButton.disabled,
    ).toBe(false);
  });

  it("captures the export region and copies it to the clipboard from 'Copy image'", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    mocks.captureUsageExportImageBlob.mockResolvedValue(blob);
    mocks.copyImageBlobPromiseToClipboard.mockResolvedValue(undefined);
    renderPanel(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    const exportRegion = screen.getByTestId("usage-export-region");

    await user.click(screen.getByTestId("usage-copy-image"));

    await waitFor(() => {
      expect(mocks.copyImageBlobPromiseToClipboard).toHaveBeenCalledTimes(1);
    });
    const [captured] = mocks.copyImageBlobPromiseToClipboard.mock.calls[0];
    await expect(captured).resolves.toBe(blob);
    expect(mocks.captureUsageExportImageBlob).toHaveBeenCalledWith({
      region: exportRegion,
      heading: "Usage",
      subheading: EXPECTED_SUBHEADING,
    });
    expect(mocks.saveBlobToDisk).not.toHaveBeenCalled();
  });

  it("names the selected metric in the subheading after the toggle switches", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    mocks.captureUsageExportImageBlob.mockResolvedValue(blob);
    mocks.copyImageBlobPromiseToClipboard.mockResolvedValue(undefined);
    renderPanel(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    await screen.findByTestId("usage-activity-section");

    await user.click(screen.getByTestId("usage-metric-tokens"));
    await user.click(screen.getByTestId("usage-copy-image"));

    await waitFor(() => {
      expect(mocks.captureUsageExportImageBlob).toHaveBeenCalledWith({
        region: screen.getByTestId("usage-export-region"),
        heading: "Usage",
        subheading: `${EXPECTED_DATE_RANGE} · Tokens`,
      });
    });
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
    renderPanel(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");

    await user.click(screen.getByTestId("usage-copy-image"));

    // The clipboard call is what has to happen inside the click's user
    // activation, so it must already have been made while the capture it was
    // handed is still pending - not after the blob lands.
    expect(mocks.copyImageBlobPromiseToClipboard).toHaveBeenCalledTimes(1);
    const [captured] = mocks.copyImageBlobPromiseToClipboard.mock.calls[0];
    resolveCapture(blob);
    await expect(captured).resolves.toBe(blob);
  });

  it("captures the export region and saves it to disk from 'Download image'", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["fake-png-bytes"], { type: "image/png" });
    mocks.captureUsageExportImageBlob.mockResolvedValue(blob);
    mocks.saveBlobToDisk.mockResolvedValue({
      name: "traycer-usage-30d.png",
      path: null,
    });
    renderPanel(usageSummaryResponse);
    await screen.findByTestId("usage-cost-figure");
    const exportRegion = screen.getByTestId("usage-export-region");

    await user.click(screen.getByTestId("usage-download-image"));

    await waitFor(() => {
      expect(mocks.saveBlobToDisk).toHaveBeenCalledWith(
        blob,
        expect.stringMatching(/^traycer-usage-30d\.png$/),
      );
    });
    expect(mocks.captureUsageExportImageBlob).toHaveBeenCalledWith({
      region: exportRegion,
      heading: "Usage",
      subheading: EXPECTED_SUBHEADING,
    });
    expect(mocks.copyImageBlobPromiseToClipboard).not.toHaveBeenCalled();
  });
});
