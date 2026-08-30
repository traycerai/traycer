import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import type { BrowserPersistenceController } from "@/lib/browser-view/use-browser-persistence-state";
import type { BrowserSavedLoginSitesResponse } from "@traycer/protocol/host/browser/contracts";

/**
 * Settings > Browser's saved-logins group (spec section 7.3). What is worth
 * pinning here is what the surface PROMISES: the toggle states the machine's
 * own decision, turning it on runs the ticket 02 enable flow rather than
 * silently probing the keystore, forgetting everything asks first, and the site
 * list carries names and nothing else.
 */

const persistence = vi.hoisted(
  (): { current: BrowserPersistenceController } => ({
    current: {
      state: null,
      pending: false,
      enable: () => undefined,
      decline: () => undefined,
      relaunch: () => undefined,
    },
  }),
);
const sites = vi.hoisted(
  (): { current: BrowserSavedLoginSitesResponse | null } => ({ current: null }),
);
const refetch = vi.hoisted(() => vi.fn());
const forgetAllBrowserLogins = vi.hoisted(() => vi.fn(() => true));
const clearSavedLoginSite = vi.hoisted(() => vi.fn(() => true));
const trackBrowserLoginsForgotten = vi.hoisted(() => vi.fn());
const trackBrowserPersistence = vi.hoisted(() => vi.fn());

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView: {} }),
}));

vi.mock("@/lib/browser-view/use-browser-persistence-state", () => ({
  useBrowserPersistenceState: () => persistence.current,
}));

vi.mock("@/hooks/browser/use-browser-saved-login-sites-query", () => ({
  useBrowserSavedLoginSitesQuery: () => ({ data: sites.current, refetch }),
}));

vi.mock("@/lib/browser-view/sessions/browser-sessions-coordinator", () => ({
  forgetAllBrowserLogins,
  clearSavedLoginSite,
}));

vi.mock("@/lib/browser-view/browser-persistence-analytics", () => ({
  trackBrowserLoginsForgotten,
  trackBrowserPersistence,
}));

function controller(
  overrides: Partial<BrowserPersistenceController>,
): BrowserPersistenceController {
  return {
    state: {
      decision: { kind: "enabled", decidedAt: 0 },
      cryptoState: {
        mode: "real",
        persistence: "persistent",
        reason: "os-backed",
        storageBackend: null,
        encryptionAvailable: true,
      },
      promptsOnEnable: false,
      appName: "Traycer",
      platform: "darwin",
    },
    pending: false,
    enable: vi.fn(),
    decline: vi.fn(),
    relaunch: vi.fn(),
    ...overrides,
  };
}

function renderSection(
  current: BrowserPersistenceController,
  data: BrowserSavedLoginSitesResponse | null,
): void {
  persistence.current = current;
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
    trackBrowserLoginsForgotten.mockClear();
    trackBrowserPersistence.mockClear();
  });

  it("reflects the machine's decision, and names the machine the way its OS does", () => {
    renderSection(controller({}), null);

    expect(screen.getByText("Save website logins on this Mac")).not.toBeNull();
    expect(toggle().getAttribute("data-state")).toBe("checked");
  });

  it("declines rather than migrating the jar back when turned off", () => {
    const current = controller({});
    renderSection(current, null);

    fireEvent.click(toggle());

    expect(current.decline).toHaveBeenCalledTimes(1);
    expect(current.enable).not.toHaveBeenCalled();
  });

  it("shows the explainer before the OS prompt, then enables on confirm", () => {
    const current = controller({
      state: {
        decision: { kind: "undecided" },
        cryptoState: {
          mode: "degraded",
          persistence: "ephemeral",
          reason: "not-enabled",
          storageBackend: null,
          encryptionAvailable: false,
        },
        // A machine where enabling raises a real keychain dialog.
        promptsOnEnable: true,
        appName: "Traycer Staging",
        platform: "darwin",
      },
    });
    renderSection(current, null);

    fireEvent.click(toggle());

    // The probe is what raises the OS dialog, so nothing may run until the
    // person has seen the mock of it.
    expect(current.enable).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        '"Traycer Staging" wants to access key "Traycer Staging Safe Storage" in your keychain.',
      ),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Enable saved logins" }),
    );

    expect(current.enable).toHaveBeenCalledTimes(1);
    // The funnel's `enable_result` is emitted inside the hook, so the only
    // thing this surface owes it is naming itself.
    expect(current.enable).toHaveBeenCalledWith("settings");
  });

  it("enables straight away where no OS dialog would be raised", () => {
    const current = controller({
      state: {
        decision: { kind: "undecided" },
        cryptoState: {
          mode: "degraded",
          persistence: "ephemeral",
          reason: "not-enabled",
          storageBackend: null,
          encryptionAvailable: false,
        },
        promptsOnEnable: false,
        appName: "Traycer",
        platform: "win32",
      },
    });
    renderSection(current, null);

    expect(screen.getByText("Save website logins on this PC")).not.toBeNull();

    fireEvent.click(toggle());

    expect(current.enable).toHaveBeenCalledTimes(1);
    expect(current.enable).toHaveBeenCalledWith("settings");
  });

  it("offers a restart, and no toggle, while a denial is cached for this run", () => {
    const current = controller({
      state: {
        decision: { kind: "relaunch-pending", decidedAt: 0 },
        cryptoState: {
          mode: "degraded",
          persistence: "ephemeral",
          reason: "keychain-denied",
          storageBackend: null,
          encryptionAvailable: true,
        },
        promptsOnEnable: true,
        appName: "Traycer",
        platform: "darwin",
      },
    });
    renderSection(current, null);

    expect(toggle().hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restart Traycer" }));

    expect(current.relaunch).toHaveBeenCalledTimes(1);
    expect(current.relaunch).toHaveBeenCalledWith("settings");
  });

  it("states the reason and disables the toggle where no keyring exists", () => {
    const current = controller({
      state: {
        decision: { kind: "undecided" },
        cryptoState: {
          mode: "degraded",
          persistence: "ephemeral",
          reason: "linux-basic-text",
          storageBackend: "basic_text",
          encryptionAvailable: true,
        },
        promptsOnEnable: false,
        appName: "Traycer",
        platform: "linux",
      },
    });
    renderSection(current, null);

    expect(screen.getByText("No secure keyring found")).not.toBeNull();
    expect(toggle().hasAttribute("disabled")).toBe(true);
  });

  it("forgets everything only after the destructive confirm", () => {
    renderSection(controller({}), null);

    fireEvent.click(
      screen.getByRole("button", { name: "Forget all browser logins…" }),
    );
    expect(forgetAllBrowserLogins).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(forgetAllBrowserLogins).toHaveBeenCalledTimes(1);
    expect(trackBrowserLoginsForgotten).toHaveBeenCalledWith("settings");
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
    // Names only: the event that reports a clear carries the surface, never
    // the site that was cleared.
    expect(trackBrowserPersistence).toHaveBeenCalledWith({
      name: "browser_site_cleared",
      source: "settings",
    });
    // The row goes at once: the host merges asynchronously, so the refetch
    // behind this click can still read the pre-clear slice.
    expect(screen.queryByText("example.com")).toBeNull();
    expect(screen.queryByText("example.org")).not.toBeNull();
  });
});
