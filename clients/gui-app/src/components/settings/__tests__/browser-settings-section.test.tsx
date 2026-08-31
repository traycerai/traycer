import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import type { BrowserSaveLoginsController } from "@/lib/browser-view/use-browser-save-logins";
import type { BrowserSavedLoginSitesResponse } from "@traycer/protocol/host/browser/contracts";

/**
 * Settings > Browser's saved-logins group. Saving is silent and on by
 * default, Chrome-style, so what is worth pinning here is what the surface
 * still promises: the toggle reflects the machine's answer, turning it off
 * goes behind a destructive confirm, forgetting everything asks first, and
 * the site list carries names and nothing else.
 */

const saveLogins = vi.hoisted((): { current: BrowserSaveLoginsController } => ({
  current: { enabled: true, pending: false, setEnabled: () => undefined },
}));
const sites = vi.hoisted(
  (): { current: BrowserSavedLoginSitesResponse | null } => ({ current: null }),
);
const refetch = vi.hoisted(() => vi.fn());
const forgetAllBrowserLogins = vi.hoisted(() => vi.fn());
const clearSavedLoginSite = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView: {} }),
}));

vi.mock("@/lib/browser-view/use-browser-save-logins", () => ({
  useBrowserSaveLogins: () => saveLogins.current,
}));

vi.mock("@/hooks/browser/use-browser-saved-login-sites-query", () => ({
  useBrowserSavedLoginSitesQuery: () => ({ data: sites.current, refetch }),
}));

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  forgetAllBrowserLogins,
  clearSavedLoginSite,
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

function renderSection(
  current: BrowserSaveLoginsController,
  data: BrowserSavedLoginSitesResponse | null,
): void {
  saveLogins.current = current;
  sites.current = data;
  render(<BrowserSettingsSection />);
}

function toggle(): HTMLElement {
  return screen.getByRole("switch", { name: "Save website logins" });
}

describe("<BrowserSettingsSection /> saved logins", () => {
  afterEach(() => {
    cleanup();
    forgetAllBrowserLogins.mockClear();
    clearSavedLoginSite.mockClear();
    refetch.mockClear();
  });

  it("reflects the machine's decision", () => {
    renderSection(controller({ enabled: true }), null);

    expect(toggle().getAttribute("data-state")).toBe("checked");
  });

  it("renders nothing until the bridge has answered", () => {
    renderSection(controller({ enabled: null }), null);

    expect(screen.queryByText("Saved logins")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("turns saving on immediately, with no confirm", () => {
    const current = controller({ enabled: false });
    renderSection(current, null);

    fireEvent.click(toggle());

    expect(current.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("turns saving off only after the destructive confirm", () => {
    const current = controller({ enabled: true });
    renderSection(current, null);

    fireEvent.click(toggle());
    expect(current.setEnabled).not.toHaveBeenCalled();
    expect(screen.getByText("Stop saving website logins?")).not.toBeNull();

    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(current.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not turn off when the confirm is cancelled", () => {
    const current = controller({ enabled: true });
    renderSection(current, null);

    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("confirm-cancel"));

    expect(current.setEnabled).not.toHaveBeenCalled();
  });

  it("forgets everything only after the destructive confirm", () => {
    renderSection(controller({}), null);

    fireEvent.click(
      screen.getByRole("button", { name: "Forget all browser logins…" }),
    );
    expect(forgetAllBrowserLogins).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(forgetAllBrowserLogins).toHaveBeenCalledTimes(1);
  });

  it("lists site names and last-seen times, and never a value", () => {
    renderSection(controller({}), {
      kind: "sites",
      sites: [
        { domain: "example.com", lastSeen: Date.now() },
        { domain: "example.org", lastSeen: Date.now() },
      ],
    });

    expect(screen.getByText("example.com")).not.toBeNull();
    expect(screen.getByText("example.org")).not.toBeNull();
    expect(screen.getAllByText("Just now")).toHaveLength(2);
    // A row is a site and a time; the wire shape it renders has no third
    // field, so there is nothing here a value could arrive in.
  });

  it("says a sealed host is locked, not empty", () => {
    renderSection(controller({}), { kind: "sealed" });

    expect(
      screen.getByText("Connect this desktop to unlock saved logins."),
    ).not.toBeNull();
    expect(screen.queryByText("No saved logins yet.")).toBeNull();
  });

  it("says so when the jar is genuinely empty", () => {
    renderSection(controller({}), { kind: "sites", sites: [] });

    expect(screen.getByText("No saved logins yet.")).not.toBeNull();
  });

  it("sends clearSite for one row and refetches the list", () => {
    renderSection(controller({}), {
      kind: "sites",
      sites: [
        { domain: "example.com", lastSeen: Date.now() },
        { domain: "example.org", lastSeen: Date.now() },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear saved logins for example.com",
      }),
    );

    expect(clearSavedLoginSite).toHaveBeenCalledWith("example.com");
    expect(refetch).toHaveBeenCalledTimes(1);
    // The row goes at once: the host merges asynchronously, so the refetch
    // behind this click can still read the pre-clear slice.
    expect(screen.queryByText("example.com")).toBeNull();
    expect(screen.queryByText("example.org")).not.toBeNull();
  });
});
