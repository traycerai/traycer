import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
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

const SESSION_HOST_ID = "host-session";

const mocks = vi.hoisted(() => ({
  requestFreshSnapshot: vi.fn(),
  sessionHostId: "host-session" as string | null,
  isDirectoryLoading: false,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicRequestFreshSnapshot: () => mocks.requestFreshSnapshot,
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: mocks.isDirectoryLoading ? undefined : [],
    isPending: mocks.isDirectoryLoading,
  }),
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => mocks.sessionHostId,
}));

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  mocks.requestFreshSnapshot.mockClear();
  mocks.sessionHostId = SESSION_HOST_ID;
  mocks.isDirectoryLoading = false;
});

const HOST_WITH_REBIND: readonly string[] = [
  "host.status",
  "host.rebindLocalStore",
];
const HOST_WITHOUT_REBIND: readonly string[] = ["host.status"];

const LOCAL_STORE_ERROR: SnapshotFetchError = {
  code: "LOCAL_STORE_UNAVAILABLE",
  message: "The local store refused to open.",
  localStoreRemedy: "Stop the other Traycer host, then rebind.",
  upgradeGuidance: null,
};

function renderBanner(): void {
  renderBannerForError(LOCAL_STORE_ERROR, HOST_WITH_REBIND);
}

function renderBannerForError(
  error: SnapshotFetchError,
  sessionHostMethods: readonly string[],
): void {
  if (mocks.sessionHostId !== null) {
    recordNegotiatedHostMethods(mocks.sessionHostId, sessionHostMethods);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SnapshotErrorBanner error={error} className={undefined} />
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

  it("keeps rebind available when the host supplied no remedy", async () => {
    const user = userEvent.setup();
    renderBannerForError(
      {
        ...LOCAL_STORE_ERROR,
        localStoreRemedy: undefined,
      },
      HOST_WITH_REBIND,
    );

    expect(screen.queryByTestId("local-store-refusal-remedy")).toBeNull();
    expect(
      screen.getByTestId<HTMLButtonElement>("local-store-rebind").disabled,
    ).toBe(false);
    await user.click(screen.getByTestId("local-store-rebind"));
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();
  });

  it("withholds the rebind action from a session host that does not advertise host.rebindLocalStore", () => {
    // The error still arrives - `LOCAL_STORE_UNAVAILABLE` rides
    // `epic.subscribe` - but the repair RPC is an independently negotiated
    // optional unary. RED before the fix: the button rendered and confirming
    // dispatched an unsupported RPC, leaving only an error toast.
    renderBannerForError(LOCAL_STORE_ERROR, HOST_WITHOUT_REBIND);

    expect(screen.queryByTestId("local-store-rebind")).toBeNull();
    // The remedy text is still the host's, and still shown.
    expect(screen.getByTestId("local-store-refusal-remedy").textContent).toBe(
      LOCAL_STORE_ERROR.localStoreRemedy,
    );
  });

  it("waits for the session host directory entry before confirming", async () => {
    const user = userEvent.setup();
    mocks.sessionHostId = "host-pending";
    mocks.isDirectoryLoading = true;
    renderBanner();

    await user.click(screen.getByTestId("local-store-rebind"));
    expect(
      screen.getByTestId<HTMLButtonElement>("confirm-action").disabled,
    ).toBe(true);
  });
});
