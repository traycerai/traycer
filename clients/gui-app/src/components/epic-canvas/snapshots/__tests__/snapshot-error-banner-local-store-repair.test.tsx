import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotErrorBanner } from "@/components/epic-canvas/snapshots/snapshot-error-banner";
import type { SnapshotFetchError } from "@/stores/epics/open-epic/store";

/**
 * The repair surface is rendered OUTSIDE every `<TabHostProvider>`.
 *
 * `LOCAL_STORE_UNAVAILABLE` is a snapshot-load failure, so `TileCanvasBody`
 * returns this banner INSTEAD of `TileCanvasLive` - no tile renderer mounts,
 * and `tile-render.tsx` is the only place that mounts `<TabHostProvider>`.
 * `SnapshotGate` in `snapshot-loading-context.tsx` sits outside it too.
 *
 * So the hook behind the rebind button may not read `useTabHostClient()`:
 * `useTabHostId()` THROWS outside the provider, which took down the one screen
 * whose entire purpose is to offer the recovery. Only the host TRANSPORT is
 * faked below - the hook's own host resolution (`useEpicSessionHostId`, whose
 * context legitimately reads `null` here) runs for real, which is where the
 * crash occurred.
 */

const mocks = vi.hoisted(() => ({
  requestFreshSnapshot: vi.fn(),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicRequestFreshSnapshot: () => mocks.requestFreshSnapshot,
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));

afterEach(() => {
  cleanup();
  mocks.requestFreshSnapshot.mockClear();
});

const LOCAL_STORE_ERROR: SnapshotFetchError = {
  code: "LOCAL_STORE_UNAVAILABLE",
  message: "The local store refused to open.",
  localStoreRemedy: "Stop the other Traycer host, then rebind.",
  upgradeGuidance: null,
};

function renderBanner(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SnapshotErrorBanner error={LOCAL_STORE_ERROR} className={undefined} />
    </QueryClientProvider>,
  );
}

describe("SnapshotErrorBanner local-store repair", () => {
  it("renders the rebind action with no tab-host context", () => {
    renderBanner();
    expect(screen.getByTestId("local-store-rebind")).toBeTruthy();
    expect(screen.getByTestId("local-store-refusal-remedy").textContent).toBe(
      LOCAL_STORE_ERROR.localStoreRemedy,
    );
  });

  it("opens the destructive confirmation from the rebind action", async () => {
    const user = userEvent.setup();
    renderBanner();
    await user.click(screen.getByTestId("local-store-rebind"));
    expect(
      screen.getByRole("button", { name: "I’ve stopped the other host" }),
    ).toBeTruthy();
  });
});
