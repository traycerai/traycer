import { describe, expect, it } from "vitest";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { searchSettings } from "@/lib/settings-search/settings-search";

/** A desktop zoom bridge: only its shape is read by the availability gate. */
const DESKTOP_ZOOM = {
  ladder: [90, 100, 110],
  get: () => Promise.resolve(100),
  set: (percent: number) => Promise.resolve(percent),
  stepIn: () => Promise.resolve(110),
  stepOut: () => Promise.resolve(90),
  reset: () => Promise.resolve(100),
  onChange: () => ({ dispose: () => undefined }),
};

const FAKE_RUNNER_HOST = createFakeRunnerHost({});

/**
 * The Electron desktop app: every desktop bridge carried on the runner host,
 * not the mobile bundle. The feature-settings bridge is left out so the one
 * case about it can add it and show the difference.
 */
const DESKTOP: SettingsAvailabilityContext = {
  runnerHost: createFakeRunnerHost({
    browserView: new FakeBrowserViewBridge(undefined),
    zoom: DESKTOP_ZOOM,
    notifications: {
      ...FAKE_RUNNER_HOST.notifications,
      systemSettings: { open: () => Promise.resolve() },
    },
  }),
  featureSettings: null,
  mobileApp: false,
};

/** The installed mobile app: no desktop bridges, push permission present. */
const MOBILE: SettingsAvailabilityContext = {
  runnerHost: createFakeRunnerHost({
    pushPermission: {
      get: () => Promise.resolve("granted"),
      request: () => Promise.resolve("granted"),
      openSettings: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
  }),
  featureSettings: null,
  mobileApp: true,
};

/** A desktop feature-settings bridge: only its presence gates Experimental. */
const FEATURE_SETTINGS = {
  get: () => Promise.resolve({ agentRoles: false }),
  setAgentRolesEnabled: (enabled: boolean) =>
    Promise.resolve({ agentRoles: enabled }),
};

/** The labels a query returns, in rank order. */
function labelsFor(
  query: string,
  context: SettingsAvailabilityContext,
): ReadonlyArray<string> {
  return searchSettings(query, context).map((result) => result.entry.label);
}

/** The first result's page + anchor — what a click would actually do. */
function landingFor(
  query: string,
  context: SettingsAvailabilityContext,
): string {
  const results = searchSettings(query, context);
  if (results.length === 0) return "<no results>";
  const first = results[0];
  return `${first.entry.section}#${first.entry.anchor ?? "<top>"}`;
}

describe("settings search", () => {
  it("returns nothing for a query that asks for nothing", () => {
    // Not "everything": the caller renders its ordinary section list in this
    // state, and a blank query is not a search with a hundred equal answers.
    expect(searchSettings("", DESKTOP)).toEqual([]);
    expect(searchSettings("   ", DESKTOP)).toEqual([]);
  });

  it("finds a row by its exact name", () => {
    expect(labelsFor("minimap side", DESKTOP)[0]).toBe("Minimap side");
  });

  it("tolerates a typo", () => {
    // The whole reason this runs through Fuse rather than `includes`.
    expect(labelsFor("minmap", DESKTOP)[0]).toBe("Minimap side");
    expect(labelsFor("typograpy", DESKTOP)).toContain("Typography");
  });

  it("finds a setting by a word its label does not contain", () => {
    // The keyword list earning its keep. None of these queries appear in the
    // label of the thing they must reach.
    // The theme gallery is bespoke, so "dark mode" lands on the page.
    expect(landingFor("dark mode", DESKTOP)).toBe("appearance#<top>");
    expect(landingFor("caffeinate", DESKTOP)).toBe(
      "general#general-prevent-sleep",
    );
    expect(labelsFor("dictation", DESKTOP)).toContain("Voice input");
    expect(labelsFor("proxy", DESKTOP)).toContain("Shell");
  });

  it("reaches a bespoke page through the vocabulary it is really about", () => {
    // Providers and Worktrees have no indexable rows — they are per-provider
    // and per-worktree at runtime — so their reachability IS their keywords.
    expect(labelsFor("mcp", DESKTOP)).toContain("MCP servers");
    expect(labelsFor("api key", DESKTOP)).toContain("API key");
    expect(labelsFor("rate limit", DESKTOP)).toContain("Profiles & limits");
  });

  it("prefers the specific row over the group that contains it", () => {
    // "Terminal cursor" is a row inside the "Terminal" group. The row is what
    // someone typing the full name means to change.
    const results = searchSettings("terminal cursor", DESKTOP);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.kind).toBe("setting");
    expect(results[0].entry.anchor).toBe("appearance-terminal-cursor");
  });

  it("still lets a page win on its own name", () => {
    // The kind nudge is small on purpose — it decides near-ties, it does not
    // outrank an exact match on a page's own name.
    expect(labelsFor("keybindings", DESKTOP)[0]).toBe("Keybindings");
    expect(labelsFor("opening behavior", DESKTOP)[0]).toBe("Opening behavior");
  });

  it("distinguishes the two pages that share a name by their scope", () => {
    // Both "Diagnostics" pages match "diagnostics" — the results have to carry
    // enough to tell them apart, which is what the scope label is for.
    const scopes = searchSettings("diagnostics", DESKTOP)
      .filter((result) => result.entry.kind === "section")
      .map((result) => result.scopeLabel);
    expect(scopes).toContain("Application");
    expect(scopes).toContain("Host");
  });

  it("matches on a two-word query that spans the page and the row", () => {
    expect(landingFor("terminal font", DESKTOP)).toBe(
      "appearance#appearance-terminal-font",
    );
    expect(landingFor("website sessions", DESKTOP)).toBe("general#<top>");
  });

  it("returns nothing for a query with no plausible match", () => {
    expect(searchSettings("qqzzxwv", DESKTOP)).toEqual([]);
  });

  it("caps the result list", () => {
    // A loose fuzzy threshold means a short query weak-matches a long tail.
    expect(searchSettings("e", DESKTOP).length).toBeLessThanOrEqual(12);
  });

  describe("availability", () => {
    // Each case is a row the OTHER shell would have offered — so a filter
    // that ignored the context entirely would fail every one of them.

    it("offers desktop-only rows on desktop and withholds them on mobile", () => {
      for (const label of [
        "Zoom",
        "OS notifications",
        "Voice input",
        "Prevent sleep while running",
      ]) {
        expect(labelsFor(label, DESKTOP), label).toContain(label);
        expect(labelsFor(label, MOBILE), label).not.toContain(label);
      }
    });

    it("offers Agent roles exactly while the feature-settings bridge exists", () => {
      expect(labelsFor("Agent roles", DESKTOP)).not.toContain("Agent roles");
      expect(
        labelsFor("Agent roles", {
          ...DESKTOP,
          featureSettings: FEATURE_SETTINGS,
        }),
      ).toContain("Agent roles");
    });

    it("offers the phone's push row on mobile and withholds it on desktop", () => {
      expect(labelsFor("push notifications", MOBILE)).toContain(
        "Push notifications",
      );
      expect(labelsFor("push notifications", DESKTOP)).not.toContain(
        "Push notifications",
      );
    });

    it("never offers the data-gated Browser rows", () => {
      // "Detected dev origins" renders only once a terminal has printed a
      // local URL. No shell can promise that, so no shell offers it.
      expect(labelsFor("dev origins", DESKTOP)).not.toContain(
        "Detected dev origins",
      );
      expect(labelsFor("browser", DESKTOP)).not.toContain("Browser");
    });

    it("sends selected-host vocabulary to the Overview page", () => {
      // Every group on a host-scoped page is dropped or concealed for an
      // unresolved, connecting or vanished host, so none is a target. Their
      // words still reach the Overview page, in any shell.
      for (const context of [DESKTOP, MOBILE]) {
        for (const query of [
          "uninstall",
          "snapshots",
          "import your work",
          "data migration",
          "installation",
          "danger zone",
        ]) {
          expect(landingsFor(query, context), query).toContain("host#<top>");
        }
      }
      expect(
        searchSettings("installation danger zone", DESKTOP).filter(
          (result) =>
            result.entry.section === "host" && result.entry.anchor !== null,
        ),
      ).toEqual([]);
      for (const label of [
        "Installation",
        "Remove Traycer from this computer",
        "Remove from account",
        "File edit snapshots",
        "Import your work",
        "Data migration",
        "Data & migration",
      ]) {
        expect(labelsFor(label, DESKTOP), label).not.toContain(label);
      }
    });

    it("sends runtime-gated groups' vocabulary to their pages", () => {
      // Website sessions also waits on a bound host runtime and a first read
      // of the browser bridge; host Notifications' groups sit behind the
      // page's scope gate. Neither is a target — their words reach the page.
      for (const context of [DESKTOP, MOBILE]) {
        for (const query of ["stay signed in", "cookies", "website sessions"]) {
          expect(landingsFor(query, context), query).toContain("general#<top>");
        }
        for (const query of ["notification hooks", "webhook", "toast"]) {
          expect(landingsFor(query, context), query).toContain(
            "notifications#<top>",
          );
        }
      }
      for (const label of [
        "Website sessions",
        "Save website sessions on this computer",
        "Bring in existing sessions",
        "Saved website sessions",
        "In-app notifications",
        "Notification hooks",
      ]) {
        expect(labelsFor(label, DESKTOP), label).not.toContain(label);
      }
    });

    it("sends the old-host-gated cards' vocabulary to their pages", () => {
      // A host too old for the config RPC replaces host Diagnostics' Log detail
      // and both Shell cards with a notice, so none of them is a target; their
      // words land on the top of the page instead.
      for (const query of ["log level", "verbosity", "host log level"]) {
        expect(landingsFor(query, DESKTOP), query).toContain(
          "diagnostics#<top>",
        );
      }
      for (const query of ["shell program", "startup flags", "wsl", "proxy"]) {
        expect(landingsFor(query, DESKTOP), query).toContain("shell#<top>");
      }
      for (const query of [
        "log detail",
        "terminal shell",
        "host environment",
      ]) {
        const cardHits = searchSettings(query, DESKTOP).filter(
          (result) =>
            (result.entry.section === "diagnostics" ||
              result.entry.section === "shell") &&
            result.entry.anchor !== null,
        );
        expect(cardHits, query).toEqual([]);
      }
    });
  });
});

/** Every result's page + anchor, in rank order. */
function landingsFor(
  query: string,
  context: SettingsAvailabilityContext,
): ReadonlyArray<string> {
  return searchSettings(query, context).map(
    (result) => `${result.entry.section}#${result.entry.anchor ?? "<top>"}`,
  );
}
