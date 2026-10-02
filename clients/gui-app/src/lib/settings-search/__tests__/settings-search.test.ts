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

/** The layout regions a query offers - a launch result acts on one of these. */
function launchesFor(
  query: string,
  context: SettingsAvailabilityContext,
): ReadonlyArray<string> {
  return searchSettings(query, context).flatMap((result) =>
    result.entry.launch === null ? [] : [result.entry.launch],
  );
}

describe("settings search", () => {
  it("returns nothing for a query that asks for nothing", () => {
    // Not "everything": the caller renders its ordinary section list in this
    // state, and a blank query is not a search with a hundred equal answers.
    expect(searchSettings("", DESKTOP)).toEqual([]);
    expect(searchSettings("   ", DESKTOP)).toEqual([]);
  });

  it("finds a row by its exact name", () => {
    expect(labelsFor("panel animations", DESKTOP)[0]).toBe("Panel animations");
  });

  it("tolerates a typo", () => {
    // The whole reason this runs through Fuse rather than `includes`.
    expect(labelsFor("minmap", DESKTOP)[0]).toBe("Minimap");
    expect(labelsFor("typograpy", DESKTOP)).toContain("Fonts and text");
  });

  it("finds a setting by a word its label does not contain", () => {
    // The keyword list earning its keep. None of these queries appear in the
    // label of the thing they must reach.
    // "dark mode" is the page's vocabulary, not a row's, so it lands on the page.
    expect(landingFor("dark mode", DESKTOP)).toBe("appearance#<top>");
    expect(landingFor("caffeinate", DESKTOP)).toBe(
      "general#general-prevent-sleep",
    );
    expect(labelsFor("dictation", DESKTOP)).toContain("Voice input");
    expect(labelsFor("proxy", DESKTOP)).toContain("Shell");
  });

  it("reaches the replay card by the words the old General row owned", () => {
    // The tour's replay moved out of General, and its vocabulary moved with
    // it: these queries appear in no label anywhere and must still land on
    // the card, anchor included, rather than at the top of a page.
    expect(landingFor("walkthrough", DESKTOP)).toBe(
      "getting-started#getting-started-product-tour",
    );
    for (const query of ["product tour", "first run", "intro"]) {
      expect(labelsFor(query, DESKTOP)).toContain("Initial tour");
    }
  });

  it("reaches the Notifications page by its former name, Inbox", () => {
    // The strip's drawer was renamed from "Inbox" to "Notifications"; the old
    // name stays in the page's keywords so it is still findable.
    expect(landingFor("inbox", DESKTOP)).toBe("notifications#<top>");
  });

  it("reaches a bespoke page through the vocabulary it is really about", () => {
    // Providers and Worktrees have no indexable rows — they are per-provider
    // and per-worktree at runtime — so their reachability IS their keywords.
    expect(labelsFor("mcp", DESKTOP)).toContain("MCP servers");
    expect(labelsFor("api key", DESKTOP)).toContain("API key");
    expect(labelsFor("rate limit", DESKTOP)).toContain("Profiles & limits");
  });

  it("reaches the Appearance diff viewer rows by their own vocabulary", () => {
    expect(landingFor("line numbers", DESKTOP)).toBe(
      "appearance#appearance-diff-line-numbers",
    );
    expect(labelsFor("gutter", DESKTOP)).toContain("Gutter marks");
  });

  it("prefers the specific row over the group that contains it", () => {
    // "Terminal cursor" is a row inside the "Terminal" group. The row is what
    // someone typing the full name means to change.
    const results = searchSettings("terminal cursor", DESKTOP);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.kind).toBe("setting");
    expect(results[0].entry.anchor).toBe("appearance-terminal-cursor");
  });

  it("lands each Permissions query on the tab or row it is about", () => {
    // "judge" is also in Providers' keywords ("auto mode judge"), so this pins
    // that the Permissions tab still outranks it.
    expect(landingFor("default permission", DESKTOP)).toBe(
      "permissions#permissions-default-permission-mode",
    );
    expect(landingFor("judge", DESKTOP)).toBe(
      "permissions#permissions-tab-judge",
    );
    expect(landingFor("policy", DESKTOP)).toBe(
      "permissions#permissions-tab-rules",
    );
    expect(landingFor("allow rule", DESKTOP)).toBe(
      "permissions#permissions-tab-rules",
    );
    expect(landingFor("activity", DESKTOP)).toBe(
      "permissions#permissions-tab-activity",
    );
  });

  it("lands built-in reviewer vocabulary on Providers and keeps auto mode judge on the Judge tab", () => {
    expect(landingFor("built-in reviewer", DESKTOP)).toBe("providers#<top>");
    expect(landingFor("own classifier", DESKTOP)).toBe("providers#<top>");
    expect(landingFor("claude code", DESKTOP)).toBe("providers#<top>");
    expect(landingFor("auto mode judge", DESKTOP)).toBe(
      "permissions#permissions-tab-judge",
    );
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

  it("reaches the Agent office default view row, group breadcrumb included", () => {
    // The row used to sit under its own Agent office group; it is now a row
    // of Appearance ▸ Tasks. A typo in its anchor or a group id that does
    // not resolve would still compile and render. This proves the entry the
    // page actually produced.
    expect(landingFor("office default view", DESKTOP)).toBe(
      "appearance#appearance-agent-office-default-view",
    );
    const results = searchSettings("office default view", DESKTOP);
    expect(results[0].entry.kind).toBe("setting");
    expect(results[0].entry.label).toBe("Agent office default view");
    expect(results[0].entry.group).toBe("Tasks");

    // "layout" is a keyword, not a word the label contains - the same
    // distinction "finds a setting by a word its label does not contain"
    // makes above, pinned for this row specifically.
    expect(labelsFor("layout", DESKTOP)).toContain("Agent office default view");
  });

  it("matches on a two-word query that spans the page and the row", () => {
    expect(landingFor("terminal font", DESKTOP)).toBe(
      "appearance#appearance-terminal-font",
    );
    expect(landingFor("website sessions", DESKTOP)).toBe("browser#<top>");
  });

  it("returns nothing for a query with no plausible match", () => {
    expect(searchSettings("qqzzxwv", DESKTOP)).toEqual([]);
  });

  it("caps the result list", () => {
    // A loose fuzzy threshold means a short query weak-matches a long tail.
    expect(searchSettings("e", DESKTOP).length).toBeLessThanOrEqual(12);
  });

  describe("Layout", () => {
    it("reaches a region by its own name and by the words the old rows owned", () => {
      // A region result carries the region rather than an element: the page
      // draws every region section, so there is nothing on it to scroll to.
      expect(launchesFor("minimap", DESKTOP)).toContain("minimap");
      expect(launchesFor("context usage", DESKTOP)).toContain("contextUsage");
      expect(launchesFor("home tab", DESKTOP)).toContain("homeTab");
      expect(launchesFor("microphone", DESKTOP)).toContain("mic");
      // The old names reach the same regions through the registry's keywords,
      // which is what keeps a reader who learned the previous page's wording
      // from landing nowhere.
      expect(launchesFor("resource monitor", DESKTOP)).toContain(
        "resourceMonitor",
      );
      expect(launchesFor("attach image", DESKTOP)).toContain("attachImage");
      // Appearance no longer offers the row at all. Asserted on the LABEL
      // rather than on "no appearance hit for this query": the threshold is
      // loose enough that a two-word query weak-matches unrelated rows on the
      // page, which says nothing about where the minimap lives.
      expect(
        searchSettings("minimap position", DESKTOP).filter(
          (result) =>
            result.entry.section === "appearance" &&
            result.entry.label === "Minimap position",
        ),
      ).toEqual([]);
    });

    it("offers every region but the microphone in the installed mobile app too", () => {
      // A region the strip does not host is hosted by the header instead, so
      // no shell withholds one for that reason - the switch that used to gate
      // the whole page is gone with the page. The mic alone follows its own
      // row's availability, which the mobile app lacks.
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["minimap", "minimap"],
        ["usage limits", "usageLimits"],
        ["resource monitor", "resourceMonitor"],
      ];
      for (const [query, region] of cases) {
        expect(launchesFor(query, MOBILE), query).toContain(region);
      }
      expect(launchesFor("microphone", MOBILE)).not.toContain("mic");
    });

    it("still lets the page win on its own name", () => {
      expect(labelsFor("layout", DESKTOP)[0]).toBe("Layout");
    });

    it("lands a surface's own name on that surface's card", () => {
      // The surface groups are the page's only anchors, so a word about a
      // whole surface has a card to land on rather than one of its regions.
      expect(landingsFor("status bar", DESKTOP)).toContain(
        "layout#layout-surface-status-bar",
      );
      expect(landingsFor("top bar", DESKTOP)).toContain(
        "layout#layout-surface-top-bar",
      );
    });

    it("indexes the small-screen status bar row in the installed app only", () => {
      expect(labelsFor("status bar on small screens", MOBILE)).toContain(
        "Status bar on small screens",
      );
      // Not on desktop: every other build draws the strip whenever the usage
      // host says so, so the switch would pick between two identical outcomes.
      expect(labelsFor("status bar on small screens", DESKTOP)).not.toContain(
        "Status bar on small screens",
      );
    });
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
        "Customize layout",
        "Tab overflow",
        "Readings on agent rows",
        "Reading width",
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
        "Push notifications on this phone",
      );
      expect(labelsFor("push notifications", DESKTOP)).not.toContain(
        "Push notifications on this phone",
      );
    });

    it("never offers the data-gated Browser rows, but still offers the page itself", () => {
      // "Detected dev origins" renders only once a terminal has printed a
      // local URL. No shell can promise that, so no shell offers it.
      expect(labelsFor("dev origins", DESKTOP)).not.toContain(
        "Detected dev origins",
      );
      // The Browser PAGE is unconditional - only its dev-origins/website-
      // sessions rows are data/host-gated - so "browser" now surfaces it.
      expect(labelsFor("browser", DESKTOP)).toContain("Browser");
    });

    it("sends selected-host vocabulary to its Overview tab", () => {
      // Every group on a host-scoped page is dropped or concealed for an
      // unresolved, connecting or vanished host, so none of the in-body
      // groups is a target — but each of the four tabs anchors on its own
      // trigger, which renders in every host state, so these words now land
      // on the TAB that answers them rather than on the bare page.
      for (const context of [DESKTOP, MOBILE]) {
        for (const query of ["uninstall", "danger zone", "installation"]) {
          expect(landingsFor(query, context), query).toContain(
            "host#host-overview-tab-installation",
          );
        }
        for (const query of [
          "snapshots",
          "import your work",
          "data migration",
        ]) {
          expect(landingsFor(query, context), query).toContain(
            "host#host-overview-tab-data",
          );
        }
      }
      // "Installation" is deliberately not in this list: that is now the
      // Installation TAB's own label, so a search for it correctly returns a
      // result labeled "Installation" — the tab trigger, not an in-body row.
      for (const label of [
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

    it("finds a setting through search, landing on the tab that holds it", () => {
      for (const [query, anchor] of [
        ["uninstall", "host-overview-tab-installation"],
        ["port forward", "host-overview-tab-ports"],
        ["release candidate", "host-overview-tab-updates"],
        ["import", "host-overview-tab-data"],
        ["version history", "host-overview-tab-data"],
        ["host id", "host-overview-tab-installation"],
      ] as const) {
        expect(landingsFor(query, DESKTOP), query).toContain(`host#${anchor}`);
      }
    });

    it("sends runtime-gated groups' vocabulary to their pages", () => {
      // Website sessions also waits on a bound host runtime and a first read
      // of the browser bridge; host Notifications' and Fallback's groups sit
      // behind their pages' scope gates, and Fallback's render only once the
      // host answers the policy read. None is a target — their words reach
      // the page.
      for (const context of [DESKTOP, MOBILE]) {
        for (const query of ["stay signed in", "cookies", "website sessions"]) {
          expect(landingsFor(query, context), query).toContain("browser#<top>");
        }
        for (const query of ["notification hooks", "webhook", "toast"]) {
          expect(landingsFor(query, context), query).toContain(
            "notifications#<top>",
          );
        }
        for (const query of ["rate limit", "failover", "equivalent models"]) {
          expect(landingsFor(query, context), query).toContain(
            "fallback#<top>",
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
        "Route automatically",
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
