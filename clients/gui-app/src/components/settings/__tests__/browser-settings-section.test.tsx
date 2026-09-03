import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { useBrowserFocusStore } from "@/stores/settings/browser-focus-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { BrowserSaveLoginsController } from "@/lib/browser-view/use-browser-save-logins";
import type {
  BrowserSavedLoginSite,
  BrowserSavedLoginSitesResponse,
} from "@traycer/protocol/host/browser/contracts";

const saveLogins = vi.hoisted((): { current: BrowserSaveLoginsController } => ({
  current: { enabled: true, pending: false, setEnabled: () => undefined },
}));
const sites = vi.hoisted(
  (): { current: BrowserSavedLoginSitesResponse | null } => ({ current: null }),
);
const queryState = vi.hoisted(() => ({ isLoading: false, isError: false }));
const refetch = vi.hoisted(() => vi.fn());
const hostBinding = vi.hoisted((): { current: object | null } => ({
  current: null,
}));
const browserView = vi.hoisted(() => ({
  forgetLogins: vi.fn(() => Promise.resolve(true)),
  clearSavedLoginSite: vi.fn((_domain: string) => Promise.resolve(true)),
}));
const browserViewState = vi.hoisted((): { current: object } => ({
  current: {},
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView: browserViewState.current }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBinding.current,
}));

vi.mock("@/lib/browser-view/use-browser-save-logins", () => ({
  useBrowserSaveLogins: () => saveLogins.current,
}));

vi.mock("@/hooks/browser/use-browser-saved-login-sites-query", () => ({
  BROWSER_SAVED_LOGIN_SITES_METHOD: "browser.savedLoginSites",
  useBrowserSavedLoginSitesQuery: () => ({
    data: sites.current,
    isLoading: queryState.isLoading,
    isError: queryState.isError,
    refetch,
  }),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

function controller(
  overrides: Partial<BrowserSaveLoginsController>,
): BrowserSaveLoginsController {
  return {
    enabled: true,
    pending: false,
    setEnabled: vi.fn(),
    ...overrides,
  };
}

function savedSite(domain: string): BrowserSavedLoginSite {
  return { domain, lastSeen: Date.now(), contributedByHostId: null };
}

function renderSection(
  current: BrowserSaveLoginsController,
  data: BrowserSavedLoginSitesResponse | null,
) {
  saveLogins.current = current;
  sites.current = data;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserSettingsSection />
    </QueryClientProvider>,
  );
}

function toggle(): HTMLElement {
  return screen.getByRole("switch", {
    name: "Save website sessions on this computer",
  });
}

function openManager(): HTMLElement {
  fireEvent.click(
    screen.getByRole("button", { name: /^(View all|Manage all)/ }),
  );
  return screen.getByRole("dialog", { name: "Saved website sessions" });
}

describe("<BrowserSettingsSection /> website sessions", () => {
  beforeEach(() => {
    browserViewState.current = browserView;
    hostBinding.current = {};
  });

  afterEach(() => {
    cleanup();
    browserView.forgetLogins.mockClear();
    browserView.clearSavedLoginSite.mockClear();
    refetch.mockClear();
    sites.current = null;
    queryState.isLoading = false;
    queryState.isError = false;
    hostBinding.current = {};
    useBrowserFocusStore.setState({ openImportLogins: false });
    useSettingsStore.setState({ browserDevOrigins: [] });
  });

  it("reflects the computer's saving decision", () => {
    renderSection(controller({ enabled: true }), null);

    expect(toggle().getAttribute("data-state")).toBe("checked");
  });

  it("renders nothing until the browser bridge has answered", () => {
    renderSection(controller({ enabled: null }), null);

    expect(screen.queryByText("Website sessions")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("turns saving on immediately", () => {
    const current = controller({ enabled: false });
    renderSection(current, null);

    fireEvent.click(toggle());

    expect(current.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("turns saving off only after confirmation", () => {
    const current = controller({ enabled: true });
    renderSection(current, null);

    fireEvent.click(toggle());
    expect(current.setEnabled).not.toHaveBeenCalled();
    expect(screen.getByText("Stop saving website sessions?")).not.toBeNull();

    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(current.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not turn saving off when confirmation is cancelled", () => {
    const current = controller({ enabled: true });
    renderSection(current, null);

    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("confirm-cancel"));

    expect(current.setEnabled).not.toHaveBeenCalled();
  });

  it("renders no website-session group without a host runtime", () => {
    hostBinding.current = null;
    useSettingsStore.setState({ browserDevOrigins: ["http://localhost:5173"] });
    renderSection(controller({ enabled: true }), {
      kind: "sites",
      sites: [savedSite("example.com")],
    });

    expect(screen.queryByText("Website sessions")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Detected dev origins")).not.toBeNull();
  });

  it("shows three alphabetical previews and discloses the exact remainder", () => {
    renderSection(controller({}), {
      kind: "sites",
      sites: [
        savedSite("zulu.example"),
        savedSite("beta.example"),
        savedSite("alpha.example"),
        savedSite("echo.example"),
        savedSite("delta.example"),
      ],
    });

    const preview = screen.getByRole("list", {
      name: "First three saved sites",
    });
    expect(
      within(preview)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["alpha.example", "beta.example", "delta.example"]);
    expect(screen.queryByText("echo.example")).toBeNull();
    expect(
      screen.getByRole("button", { name: "View all 2 more sites" }),
    ).not.toBeNull();
    expect(screen.queryByText("Just now")).toBeNull();

    const manager = openManager();
    expect(
      within(manager)
        .getAllByRole("listitem")
        .map((row) => row.textContent.replace("Remove", "")),
    ).toEqual([
      "alpha.example",
      "beta.example",
      "delta.example",
      "echo.example",
      "zulu.example",
    ]);
  });

  it("searches the side sheet and distinguishes an empty search", () => {
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("alpha.example"), savedSite("beta.example")],
    });
    const manager = openManager();
    const search = within(manager).getByLabelText("Search saved sites");

    fireEvent.change(search, { target: { value: "missing" } });

    expect(within(manager).getByText("0 of 2 sites")).not.toBeNull();
    expect(within(manager).getByText("No matching sites")).not.toBeNull();
    expect(
      within(manager).queryByRole("button", { name: "Choose source…" }),
    ).toBeNull();

    fireEvent.click(
      within(manager).getByRole("button", { name: "Clear search" }),
    );
    expect(within(manager).getByText("2 sites")).not.toBeNull();
  });

  it("keeps a sealed collection distinct from an empty one", () => {
    renderSection(controller({}), { kind: "sealed" });

    expect(screen.getByText("Locked")).not.toBeNull();
    expect(
      screen.getByText(/Connect this desktop to unlock saved website sessions/),
    ).not.toBeNull();
    expect(screen.queryByText("0 sites")).toBeNull();
  });

  it("shows loading and recoverable failure states", () => {
    queryState.isLoading = true;
    const view = renderSection(controller({}), null);
    expect(screen.getByText("Loading…")).not.toBeNull();

    queryState.isLoading = false;
    queryState.isError = true;
    view.rerender(<BrowserSettingsSection />);
    expect(screen.getByText("Unavailable")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows a genuine empty collection without an unnecessary disclosure", () => {
    renderSection(controller({}), { kind: "sites", sites: [] });

    expect(screen.getByText("0 sites")).not.toBeNull();
    expect(
      screen.queryByRole("list", { name: "First three saved sites" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^(View all|Manage all)/ }),
    ).toBeNull();
  });

  it("removes one site only after main confirms", async () => {
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    });
    const manager = openManager();

    fireEvent.click(
      within(manager).getByRole("button", {
        name: "Remove saved website session for example.com",
      }),
    );

    expect(browserView.clearSavedLoginSite).toHaveBeenCalledWith("example.com");
    await waitFor(() => {
      expect(refetch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("example.com")).toBeNull();
    expect(screen.getAllByText("example.org").length).toBeGreaterThan(0);
  });

  it("holds an optimistic removal through a stale reply, then releases it", async () => {
    const bothSites: BrowserSavedLoginSitesResponse = {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    };
    saveLogins.current = controller({});
    sites.current = bothSites;
    const view = render(<BrowserSettingsSection />);
    const manager = openManager();

    fireEvent.click(
      within(manager).getByRole("button", {
        name: "Remove saved website session for example.com",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("example.com")).toBeNull();
    });

    view.rerender(<BrowserSettingsSection />);
    expect(screen.queryByText("example.com")).toBeNull();

    sites.current = {
      kind: "sites",
      sites: [savedSite("example.org")],
    };
    view.rerender(<BrowserSettingsSection />);
    sites.current = bothSites;
    view.rerender(<BrowserSettingsSection />);

    expect(screen.getAllByText("example.com").length).toBeGreaterThan(0);
  });

  it("leaves a site in place when main declines or rejects", async () => {
    browserView.clearSavedLoginSite
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("the main process went away"));
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("example.com")],
    });
    const manager = openManager();
    const remove = () =>
      within(manager).getByRole("button", {
        name: "Remove saved website session for example.com",
      });

    fireEvent.click(remove());
    await waitFor(() => {
      expect(browserView.clearSavedLoginSite).toHaveBeenCalledTimes(1);
    });
    expect(remove()).not.toBeNull();

    fireEvent.click(remove());
    await waitFor(() => {
      expect(browserView.clearSavedLoginSite).toHaveBeenCalledTimes(2);
    });
    expect(remove()).not.toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("keeps the sheet open on remove all and reveals the import next step", async () => {
    const bridge = new FakeBrowserViewBridge();
    const forgetLogins = vi.spyOn(bridge, "forgetLogins");
    browserViewState.current = bridge;
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    });
    const manager = openManager();

    fireEvent.click(
      within(manager).getByRole("button", { name: "Remove all…" }),
    );

    expect(forgetLogins).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-action")).toBeNull();
    await waitFor(() => {
      expect(
        within(manager).getByText("No saved website sessions"),
      ).not.toBeNull();
    });
    expect(
      within(manager).getByRole("button", { name: "Choose source…" }),
    ).not.toBeNull();
    expect(
      within(manager).getByRole("button", { name: "Done" }),
    ).not.toBeNull();

    fireEvent.click(
      within(manager).getByRole("button", { name: "Choose source…" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("import-logins-dialog")).not.toBeNull();
    });
    expect(
      screen.queryByRole("dialog", { name: "Saved website sessions" }),
    ).toBeNull();
  });

  it("keeps previews manageable while saving is paused and disables import with a reason", () => {
    renderSection(controller({ enabled: false }), {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    });

    expect(screen.getByText("example.com")).not.toBeNull();
    expect(
      screen.getByText(
        "Saving is paused on this computer. Existing sessions stay available to manage.",
      ),
    ).not.toBeNull();
    const importButton = screen.getByRole("button", { name: "Choose source…" });
    expect(importButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Turn on Save website sessions first."),
    ).not.toBeNull();
  });

  it("opens the existing import flow from the outcome-led row", async () => {
    browserViewState.current = new FakeBrowserViewBridge();
    renderSection(controller({ enabled: true }), null);

    fireEvent.click(screen.getByRole("button", { name: "Choose source…" }));

    await waitFor(() => {
      expect(screen.getByTestId("import-logins-dialog")).not.toBeNull();
    });
    expect(
      screen.getByRole("heading", {
        name: "Import logins from another browser",
      }),
    ).not.toBeNull();
  });

  describe("the import intent", () => {
    it("opens the import flow on mount without a click", async () => {
      browserViewState.current = new FakeBrowserViewBridge();
      useBrowserFocusStore.getState().requestImportLogins();

      renderSection(controller({ enabled: true }), null);

      await waitFor(() => {
        expect(screen.getByTestId("import-logins-dialog")).not.toBeNull();
      });
    });

    it("consumes the intent when the dialog closes", async () => {
      browserViewState.current = new FakeBrowserViewBridge();
      useBrowserFocusStore.getState().requestImportLogins();
      renderSection(controller({ enabled: true }), null);
      await waitFor(() => {
        expect(screen.getByTestId("import-logins-dialog")).not.toBeNull();
      });

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByTestId("import-logins-dialog")).toBeNull();
      });
      expect(useBrowserFocusStore.getState().openImportLogins).toBe(false);
    });

    it("drops an intent while session saving is off", async () => {
      browserViewState.current = new FakeBrowserViewBridge({
        saveLogins: false,
      });
      useBrowserFocusStore.getState().requestImportLogins();

      renderSection(controller({ enabled: false }), null);

      await waitFor(() => {
        expect(useBrowserFocusStore.getState().openImportLogins).toBe(false);
      });
      expect(screen.queryByTestId("import-logins-dialog")).toBeNull();
    });
  });
});
