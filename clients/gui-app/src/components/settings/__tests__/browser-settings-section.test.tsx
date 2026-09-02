import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import type { BrowserSaveLoginsController } from "@/lib/browser-view/use-browser-save-logins";
import type {
  BrowserSavedLoginSite,
  BrowserSavedLoginSitesResponse,
} from "@traycer/protocol/host/browser/contracts";

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
/**
 * A row exactly as a host that PREDATES `contributedByHostId` delivers it: the
 * field is absent, not null. The same-minor RPC path hands the payload back
 * unparsed, so the schema's `.default(null)` never runs on it - which is why
 * the surface has to survive the field being `undefined` at runtime.
 */
type PreFieldSavedLoginSite = Omit<
  BrowserSavedLoginSite,
  "contributedByHostId"
>;

/** What the query hands the section, older hosts included. */
type SavedLoginSitesAnswer =
  | Extract<BrowserSavedLoginSitesResponse, { kind: "sealed" }>
  | {
      readonly kind: "sites";
      readonly sites: readonly (
        | BrowserSavedLoginSite
        | PreFieldSavedLoginSite
      )[];
    };

const sites = vi.hoisted((): { current: SavedLoginSitesAnswer | null } => ({
  current: null,
}));
const refetch = vi.hoisted(() => vi.fn());
/**
 * The host directory the provenance line (ticket 06) resolves names through.
 * Only the SOURCE is faked here: `useHostDirectoryEntry` and
 * `useReactiveLocalHostId` are the real hooks, so a row renders exactly what
 * the app's own host-naming would give it.
 */
const hostDirectory = vi.hoisted(
  (): {
    localHostId: string | null;
    /** A host with no entry is one this client cannot currently list. */
    labels: Record<string, string | undefined>;
  } => ({
    localHostId: null,
    labels: {},
  }),
);
/** Whatever a host runtime IS here - the group only asks whether one exists. */
const hostBinding = vi.hoisted((): { current: object | null } => ({
  current: null,
}));
/**
 * The bridge itself, not a stand-in for the renderer helper that calls it:
 * both destructive actions are confirmed AND fanned out in main, and what is
 * worth pinning is that the surface asks main and believes main's answer.
 * Booleans, because that is the contract both methods declare.
 */
const browserView = vi.hoisted(() => ({
  forgetLogins: vi.fn(() => Promise.resolve(true)),
  clearSavedLoginSite: vi.fn((_domain: string) => Promise.resolve(true)),
}));

function boundHostRuntime(): object {
  return {
    directory: {
      getLocalHostId: () => hostDirectory.localHostId,
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBinding.current,
  useHostDirectory: () => ({
    findById: (hostId: string) => {
      const label = hostDirectory.labels[hostId];
      return label === undefined
        ? null
        : {
            hostId,
            label,
            kind: "remote",
            websocketUrl: null,
            version: null,
            transportDialability: "dialable",
          };
    },
    onChange: () => ({ dispose: () => undefined }),
  }),
}));

vi.mock("@/lib/browser-view/use-browser-save-logins", () => ({
  useBrowserSaveLogins: () => saveLogins.current,
}));

vi.mock("@/hooks/browser/use-browser-saved-login-sites-query", () => ({
  useBrowserSavedLoginSitesQuery: () => ({ data: sites.current, refetch }),
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

/** A row nobody but this desktop contributed - the ordinary case. */
function savedSite(domain: string): BrowserSavedLoginSite {
  return { domain, lastSeen: Date.now(), contributedByHostId: null };
}

function renderSection(
  current: BrowserSaveLoginsController,
  data: SavedLoginSitesAnswer | null,
): void {
  saveLogins.current = current;
  sites.current = data;
  render(<BrowserSettingsSection />);
}

function toggle(): HTMLElement {
  return screen.getByRole("switch", { name: "Save website logins" });
}

describe("<BrowserSettingsSection /> saved logins", () => {
  beforeEach(() => {
    hostBinding.current = boundHostRuntime();
    hostDirectory.localHostId = null;
    hostDirectory.labels = {};
  });

  afterEach(() => {
    cleanup();
    browserView.forgetLogins.mockClear();
    browserView.clearSavedLoginSite.mockClear();
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

  it("asks the main process directly, with no renderer confirmation of its own", () => {
    renderSection(controller({}), null);

    fireEvent.click(
      screen.getByRole("button", { name: "Forget all browser logins…" }),
    );

    // Main raises a native dialog and is the authority on the answer (browser
    // security review, root cause C). A second confirmation here would ask
    // twice and, worse, would read as the gate while the real one is
    // elsewhere - so the click goes straight through and no dialog opens.
    expect(browserView.forgetLogins).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-action")).toBeNull();
  });

  it("renders nothing at all without a host runtime", () => {
    hostBinding.current = null;
    renderSection(controller({ enabled: true }), {
      kind: "sites",
      sites: [savedSite("example.com")],
    });

    // The whole group goes, not just the list: with no host to answer, both
    // destructive actions would reach nobody.
    expect(screen.queryByText("Saved logins")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Forget all browser logins…" }),
    ).toBeNull();
    // The rest of the Browser section is unaffected.
    expect(screen.getByText("Web link default")).not.toBeNull();
  });

  it("lists site names and last-seen times, and never a value", () => {
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    });

    expect(screen.getByText("example.com")).not.toBeNull();
    expect(screen.getByText("example.org")).not.toBeNull();
    expect(screen.getAllByText("Just now")).toHaveLength(2);
    // A row is a site, a time, and (ticket 06) which machine contributed it.
    // Nothing on that wire shape can carry a cookie value.
  });

  it("says a sealed host is locked, not empty", () => {
    renderSection(controller({}), { kind: "sealed" });

    // Substring: the sealed line also states the keystore reason (H03), and a
    // machine whose keystore does not encrypt lands in exactly this state.
    expect(
      screen.getByText(/Connect this desktop to unlock saved logins\./),
    ).not.toBeNull();
    expect(
      screen.getByText(/Traycer will not encrypt them here/),
    ).not.toBeNull();
    expect(screen.queryByText("No saved logins yet.")).toBeNull();
  });

  it("says so when the jar is genuinely empty", () => {
    renderSection(controller({}), { kind: "sites", sites: [] });

    expect(screen.getByText("No saved logins yet.")).not.toBeNull();
  });

  it("holds the cleared row through the pre-merge window, then releases it", async () => {
    const bothSites: SavedLoginSitesAnswer = {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    };
    saveLogins.current = controller({});
    sites.current = bothSites;
    const view = render(<BrowserSettingsSection />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear saved logins for example.com",
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("example.com")).toBeNull();
    });

    // The host merges asynchronously, so the answer behind the click can still
    // name the site. The row stays hidden - that is what the optimism is for.
    view.rerender(<BrowserSettingsSection />);
    expect(screen.queryByText("example.com")).toBeNull();

    // The merge lands and the host drops it.
    sites.current = {
      kind: "sites",
      sites: [savedSite("example.org")],
    };
    view.rerender(<BrowserSettingsSection />);
    expect(screen.queryByText("example.com")).toBeNull();

    // The user signs into that site again. The row has to come back: before
    // this it stayed hidden for the rest of the session.
    sites.current = bothSites;
    view.rerender(<BrowserSettingsSection />);
    expect(screen.getByText("example.com")).not.toBeNull();
  });

  it("sends clearSite for one row, and hides it once main confirms", async () => {
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear saved logins for example.com",
      }),
    );

    expect(browserView.clearSavedLoginSite).toHaveBeenCalledWith("example.com");

    await waitFor(() => {
      expect(refetch).toHaveBeenCalledTimes(1);
    });
    // The row goes once main confirms: the host merges asynchronously, so the
    // refetch behind this click can still read the pre-clear slice.
    expect(screen.queryByText("example.com")).toBeNull();
    expect(screen.queryByText("example.org")).not.toBeNull();
  });

  it("leaves the row in place when main declines the confirmation", async () => {
    browserView.clearSavedLoginSite.mockResolvedValueOnce(false);
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear saved logins for example.com",
      }),
    );

    await waitFor(() => {
      expect(browserView.clearSavedLoginSite).toHaveBeenCalledWith(
        "example.com",
      );
    });
    expect(refetch).not.toHaveBeenCalled();
    expect(screen.getByText("example.com")).not.toBeNull();
  });

  it("leaves the row in place when the confirmation IPC rejects", async () => {
    // A rejected invoke is not a confirmation, and a click handler is no place
    // for it to escape from: main told nobody, so the row must stay.
    browserView.clearSavedLoginSite.mockRejectedValueOnce(
      new Error("the main process went away"),
    );
    renderSection(controller({}), {
      kind: "sites",
      sites: [savedSite("example.com"), savedSite("example.org")],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear saved logins for example.com",
      }),
    );

    await waitFor(() => {
      expect(browserView.clearSavedLoginSite).toHaveBeenCalledWith(
        "example.com",
      );
    });
    expect(refetch).not.toHaveBeenCalled();
    expect(screen.getByText("example.com")).not.toBeNull();
  });

  /**
   * Provenance (universal-sign-in decision 9). One muted line, and only where
   * it tells the person something they could not already assume: a login some
   * OTHER machine of theirs signed into.
   */
  describe("attribution", () => {
    /** Any line the provenance copy could produce. */
    const ATTRIBUTION_LINE = /^Includes a sign-in from/;

    function contributed(
      domain: string,
      hostId: string | null,
    ): BrowserSavedLoginSite {
      return { domain, lastSeen: Date.now(), contributedByHostId: hostId };
    }

    it("names the machine a remote host contributed a sign-in from", () => {
      hostDirectory.localHostId = "host-here";
      hostDirectory.labels = { "host-there": "Studio Mac" };
      renderSection(controller({}), {
        kind: "sites",
        sites: [contributed("example.com", "host-there")],
      });

      expect(
        screen.getByText("Includes a sign-in from Studio Mac"),
      ).not.toBeNull();
    });

    it("says nothing about a login this machine's own host contributed", () => {
      hostDirectory.localHostId = "host-here";
      hostDirectory.labels = { "host-here": "This Mac" };
      renderSection(controller({}), {
        kind: "sites",
        sites: [contributed("example.com", "host-here")],
      });

      // The user signed in here. Naming their own machine on the row would be
      // noise around the lines that mean "this came from somewhere else".
      expect(screen.getByText("example.com")).not.toBeNull();
      expect(screen.queryByText(ATTRIBUTION_LINE)).toBeNull();
    });

    it("says nothing when the answer attributes nobody", () => {
      hostDirectory.localHostId = "host-here";
      renderSection(controller({}), {
        kind: "sites",
        sites: [savedSite("example.com")],
      });

      expect(screen.queryByText(ATTRIBUTION_LINE)).toBeNull();
    });

    it("says nothing for a field an older host never sent", () => {
      hostDirectory.localHostId = "host-here";
      const preField: PreFieldSavedLoginSite = {
        domain: "example.com",
        lastSeen: Date.now(),
      };
      renderSection(controller({}), { kind: "sites", sites: [preField] });

      // `undefined`, not `null`: the same-minor RPC path returns the host's
      // payload unparsed, so the schema default never runs. A `!== null` guard
      // passes it straight through and renders a dangling line naming nobody.
      expect(screen.getByText("example.com")).not.toBeNull();
      expect(screen.queryByText(ATTRIBUTION_LINE)).toBeNull();
    });

    it("attributes every marked row where there is no local machine at all", () => {
      // Web and mobile shells: `useReactiveLocalHostId` answers null because
      // there is genuinely no local host here, so nothing a host contributed
      // is "mine" and every marked row keeps its line.
      hostDirectory.localHostId = null;
      hostDirectory.labels = { "host-there": "Studio Mac" };
      renderSection(controller({}), {
        kind: "sites",
        sites: [contributed("example.com", "host-there")],
      });

      expect(
        screen.getByText("Includes a sign-in from Studio Mac"),
      ).not.toBeNull();
    });

    it("falls back to the canonical id for a host it cannot name", () => {
      hostDirectory.localHostId = "host-here";
      renderSection(controller({}), {
        kind: "sites",
        sites: [contributed("example.com", "host-there")],
      });

      // No directory row for it, so there is no display name to resolve. The
      // id is what the app's own naming falls back to; inventing "another
      // machine" would claim more than is known.
      expect(
        screen.getByText("Includes a sign-in from host-there"),
      ).not.toBeNull();
    });
  });
});
