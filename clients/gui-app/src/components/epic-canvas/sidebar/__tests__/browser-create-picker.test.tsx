import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserCreatePicker } from "../browser-create-picker";

interface FakeHost {
  hostId: string;
  name: string;
  connectable: boolean;
  health: { state: string };
  sandbox: { frozen: boolean; summary: null } | null;
  entry: null;
  item: null;
}

const state = vi.hoisted(() => ({
  hosts: [] as FakeHost[],
  pinned: "host-home",
  setSelection: vi.fn(),
  withOwner: vi.fn(),
  openTab: vi.fn(),
  openTile: vi.fn(),
  inventoryStatus: "available",
  localHostId: "host-home",
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: state.hosts,
    isLoading: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: vi.fn(),
  }),
}));
vi.mock("@/components/epic-canvas/renderers/browser-catalog-context", () => ({
  useBrowserCatalogContext: () => ({
    inventory: { status: state.inventoryStatus },
  }),
}));
vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useBrowserSessionsContext: () => ({ hostId: state.localHostId }),
}));
vi.mock("@/hooks/browser/use-browser-catalog-actions", () => ({
  useBrowserCatalogActions: () => ({
    closeTab: vi.fn(),
    withOwner: state.withOwner,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: state.openTile }),
}));
vi.mock("@/hooks/host/use-surface-host-pin", () => ({
  useTabSurfaceKey: (kind: string, tabId: string) => `${kind}:${tabId}`,
  useSurfaceHostPin: () => ({
    selection: null,
    // A simulator pin must not steer the browser suggestion.
    resolvedHostId: "host-vm",
    followingHostId: state.pinned,
    setSelection: state.setSelection,
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function fakeHost(
  hostId: string,
  name: string,
  health: string,
  overrides: Partial<FakeHost>,
): FakeHost {
  return {
    hostId,
    name,
    connectable: true,
    health: { state: health },
    sandbox: null,
    entry: null,
    item: null,
    ...overrides,
  };
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function wrap(children: ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

async function openPicker() {
  const user = userEvent.setup();
  render(
    wrap(
      <BrowserCreatePicker
        epicId="epic-1"
        tabId="tab-1"
        onOpened={null}
        testId="add"
        trigger="icon"
      />,
    ),
  );
  await user.click(screen.getByTestId("add"));
  await screen.findByTestId("browser-create-device-picker");
  return user;
}

describe("BrowserCreatePicker", () => {
  beforeEach(() => {
    state.hosts = [
      fakeHost("host-work", "Work Mac", "online", {}),
      fakeHost("host-home", "Home Mac", "online", {}),
      fakeHost("host-vm", "Build VM", "unknown", {}),
      fakeHost("host-nas", "NAS", "offline", {}),
    ];
    state.pinned = "host-home";
    state.inventoryStatus = "available";
    state.localHostId = "host-home";
    state.setSelection.mockReset();
    state.withOwner.mockReset();
    state.openTab.mockReset();
    state.openTile.mockReset();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(cleanup);

  it("lists every available device, suggests the task's host first, and states unknown and offline", async () => {
    await openPicker();
    const items = screen.getAllByRole("menuitem");
    expect(items[0]?.textContent).toContain("Home Mac");
    expect(items[0]?.textContent).toContain("Suggested");
    expect(
      screen.getByRole("menuitem", { name: /Build VM/ }).textContent,
    ).toContain("Availability unknown");
    expect(
      screen
        .getByRole("menuitem", { name: /Build VM/ })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
    expect(
      screen
        .getByRole("menuitem", { name: /NAS/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByRole("menuitem", { name: /NAS/ }).textContent).toContain(
      "Offline",
    );
    expect(screen.getByText("New browser on")).toBeTruthy();
  });

  it("creates on the chosen device, without redirecting it or changing the task host", async () => {
    state.withOwner.mockResolvedValue(undefined);
    const user = await openPicker();
    await user.click(screen.getByRole("menuitem", { name: /Work Mac/ }));
    await waitFor(() => expect(state.withOwner).toHaveBeenCalledTimes(1));
    expect(state.withOwner.mock.calls[0]?.[0]).toBe("host-work");
    expect(state.setSelection).not.toHaveBeenCalled();
  });

  it("reports a failed creation, makes no second attempt elsewhere, and offers the picker again", async () => {
    state.withOwner.mockRejectedValue(
      new Error("Couldn't connect to this device. Try again."),
    );
    const user = await openPicker();
    await user.click(screen.getByRole("menuitem", { name: /Work Mac/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't connect to this device. Try again.",
      ),
    );
    expect(state.withOwner).toHaveBeenCalledTimes(1);
    expect(state.openTile).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("add").hasAttribute("disabled")).toBe(false),
    );
  });

  it("offers only the owning device for a local-only task", async () => {
    state.inventoryStatus = "local-only";
    state.localHostId = "host-work";
    await openPicker();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Work Mac"]);
  });

  it("is unavailable for a task whose browsers this account cannot reach", () => {
    state.inventoryStatus = "inaccessible";
    render(
      wrap(
        <BrowserCreatePicker
          epicId="epic-1"
          tabId="tab-1"
          onOpened={null}
          testId="add"
          trigger="label"
        />,
      ),
    );
    expect(screen.getByTestId("add").hasAttribute("disabled")).toBe(true);
  });
});
