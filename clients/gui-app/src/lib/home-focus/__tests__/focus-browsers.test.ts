import { describe, expect, it } from "vitest";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import {
  browsersByEpicId,
  browserTabTitleKey,
  buildFocusBrowsers,
  epicIdsWithBrowsers,
  focusBrowserKey,
  focusBrowserStatus,
  focusBrowserTabTitles,
  type FocusBrowserEpic,
} from "@/lib/home-focus/focus-browsers";
import {
  focusAgentKey,
  type FocusAgentIdentity,
} from "@/lib/home-focus/focus-tasks";
import type { FocusBrowserRow } from "@/lib/home-focus/focus-model";

/**
 * The browser plane's whole projection, decided on literal inventories.
 *
 * Pure by construction: the hook's job is to read the coordinator registry, and
 * this builder's job is to turn what it read into rows. Keeping them apart is
 * what lets the ordering rule, the title fallback and the driven-by join be
 * argued about without a live `browser.sessions` stream.
 */

function tab(overrides: Partial<BrowserTabInfo>): BrowserTabInfo {
  return {
    tabId: "tab-1",
    url: "https://example.com/checkout",
    originTier: "external",
    status: "ready",
    title: "Checkout",
    viewed: false,
    drivenBy: [],
    boundWindowId: null,
    ...overrides,
  };
}

function session(overrides: Partial<BrowserSessionInfo>): BrowserSessionInfo {
  return {
    sessionId: "session-1",
    scope: { kind: "epic", epicId: "epic-1" },
    hostId: "host-a",
    profile: "primary",
    lastActivityAt: 0,
    runtime: { kind: "headless", revision: 1 },
    tabs: [tab({})],
    ...overrides,
  };
}

function epic(overrides: Partial<FocusBrowserEpic>): FocusBrowserEpic {
  return {
    epicId: "epic-1",
    taskTitle: "Storefront",
    sessions: [session({})],
    ...overrides,
  };
}

function identity(title: string): FocusAgentIdentity {
  return { title, surface: "chat", parentId: null, hostId: "host-a" };
}

/** No default parameters (repo rule): every caller states its identities and
 * its baseline, which is also the half of the contract identity reuse turns
 * on. */
function build(
  epics: ReadonlyArray<FocusBrowserEpic>,
  agentIdentities: ReadonlyMap<string, FocusAgentIdentity>,
  previous: ReadonlyArray<FocusBrowserRow>,
): ReadonlyArray<FocusBrowserRow> {
  return buildFocusBrowsers({ epics, agentIdentities }, previous);
}

const NO_IDENTITIES: ReadonlyMap<string, FocusAgentIdentity> = new Map();
const NO_PREVIOUS: ReadonlyArray<FocusBrowserRow> = [];

describe("buildFocusBrowsers", () => {
  it("emits one row per tab, not per session", () => {
    const rows = build(
      [
        epic({
          sessions: [
            session({
              sessionId: "session-a",
              tabs: [
                tab({ tabId: "t1", title: "Checkout" }),
                tab({ tabId: "t2", title: "Cart" }),
              ],
            }),
            session({ sessionId: "session-b", tabs: [tab({ tabId: "t3" })] }),
          ],
        }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.tabId)).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps each session's own tab order rather than sorting by id", () => {
    const rows = build(
      [
        epic({
          sessions: [
            session({
              tabs: [
                tab({ tabId: "zulu", title: "Opened first" }),
                tab({ tabId: "alpha", title: "Opened second" }),
              ],
            }),
          ],
        }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );

    // Sidebar order: the sequence the host reports, which is the order the
    // tabs were opened in. Sorting by id would reshuffle a list the user is
    // clicking through.
    expect(rows.map((row) => row.title)).toEqual([
      "Opened first",
      "Opened second",
    ]);
  });

  it("orders by epic, then host, then session", () => {
    const rows = build(
      [
        epic({
          epicId: "epic-b",
          sessions: [session({ sessionId: "s1", hostId: "host-z" })],
        }),
        epic({
          epicId: "epic-a",
          sessions: [
            session({ sessionId: "s3", hostId: "host-b" }),
            session({ sessionId: "s2", hostId: "host-a" }),
          ],
        }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );

    expect(rows.map((row) => [row.epicId, row.hostId, row.sessionId])).toEqual([
      ["epic-a", "host-a", "s2"],
      ["epic-a", "host-b", "s3"],
      ["epic-b", "host-z", "s1"],
    ]);
  });

  it("sorts two sessions of one host and epic by id, whatever order they arrive in", () => {
    const rows = build(
      [
        epic({
          sessions: [
            session({
              sessionId: "session-z",
              tabs: [tab({ tabId: "z1", title: "Later session" })],
            }),
            session({
              sessionId: "session-a",
              tabs: [tab({ tabId: "a1", title: "Earlier session" })],
            }),
          ],
        }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );

    // The registry hands coordinators back in insertion order, which is when
    // their canvases happened to mount - not a fact about the pages. Session id
    // is what makes the list the same on every render.
    expect(rows.map((row) => row.sessionId)).toEqual([
      "session-a",
      "session-z",
    ]);
  });

  it("falls back to the url host when a tab has no document title", () => {
    const rows = build(
      [
        epic({
          sessions: [
            session({
              tabs: [
                tab({ title: null, url: "https://shop.example.com/cart" }),
              ],
            }),
          ],
        }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );

    expect(rows[0]?.title).toBe("shop.example.com");
    // Not repeated as the muted second part: `shop.example.com ·
    // shop.example.com` is the row saying one thing twice.
    expect(rows[0]?.urlHost).toBeNull();
  });

  it("keeps the url host beside a real title", () => {
    const rows = build([], NO_IDENTITIES, NO_PREVIOUS);
    expect(rows).toEqual([]);
    const titled = build(
      [
        epic({
          sessions: [
            session({
              tabs: [
                tab({ title: "Checkout", url: "https://shop.example.com/c" }),
              ],
            }),
          ],
        }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );
    expect([titled[0]?.title, titled[0]?.urlHost]).toEqual([
      "Checkout",
      "shop.example.com",
    ]);
  });

  it("names the chat driving a tab when this window can resolve it", () => {
    const rows = build(
      [
        epic({
          sessions: [
            session({
              tabs: [
                tab({
                  drivenBy: [
                    { chatId: "chat-1", agentRunId: "run-1", requestId: "r" },
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
      new Map([[focusAgentKey("epic-1", "chat-1"), identity("Reviewer")]]),
      NO_PREVIOUS,
    );

    expect(rows[0]?.drivenByChatId).toBe("chat-1");
    expect(rows[0]?.drivenByAgentName).toBe("Reviewer");
  });

  it("keeps the driving chat id but no name for an epic it cannot resolve", () => {
    const rows = build(
      [
        epic({
          sessions: [
            session({
              tabs: [
                tab({
                  drivenBy: [
                    { chatId: "chat-1", agentRunId: null, requestId: "r" },
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );

    expect(rows[0]?.drivenByChatId).toBe("chat-1");
    expect(rows[0]?.drivenByAgentName).toBeNull();
  });

  it("reuses unchanged rows so an unrelated frame re-renders nothing", () => {
    const first = build([epic({})], NO_IDENTITIES, NO_PREVIOUS);
    const second = build([epic({})], NO_IDENTITIES, first);

    expect(second).toBe(first);
  });

  it("mints new rows when a tab navigates", () => {
    const first = build([epic({})], NO_IDENTITIES, NO_PREVIOUS);
    const second = build(
      [
        epic({
          sessions: [session({ tabs: [tab({ title: "Order placed" })] })],
        }),
      ],
      NO_IDENTITIES,
      first,
    );

    expect(second).not.toBe(first);
    expect(second[0]?.title).toBe("Order placed");
  });

  it("keys a row by host, session and tab, the sidebar's own composite", () => {
    const rows = build([epic({})], NO_IDENTITIES, NO_PREVIOUS);
    expect(rows[0]?.key).toBe(focusBrowserKey("host-a", "session-1", "tab-1"));
  });
});

describe("focusBrowserStatus", () => {
  it("collapses the four ordinary moments of a tab's life into live", () => {
    expect(
      (["provisioning", "ready", "navigating", "closing"] as const).map(
        focusBrowserStatus,
      ),
    ).toEqual(["live", "live", "live", "live"]);
  });

  it("keeps the two states that change what a reader does next", () => {
    expect(focusBrowserStatus("dormant")).toBe("dormant");
    expect(focusBrowserStatus("crashed")).toBe("crashed");
  });
});

describe("browser row lookups", () => {
  it("groups rows by epic for the Tasks view", () => {
    const rows = build(
      [
        epic({ epicId: "epic-a" }),
        epic({ epicId: "epic-b", sessions: [session({ sessionId: "s2" })] }),
      ],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );
    const byEpic = browsersByEpicId(rows);

    expect(Array.from(byEpic.keys()).sort()).toEqual(["epic-a", "epic-b"]);
    expect(byEpic.get("epic-a")).toHaveLength(1);
  });

  it("indexes tab titles by the ids a browser prompt's payload carries", () => {
    const rows = build([epic({})], NO_IDENTITIES, NO_PREVIOUS);
    const titles = focusBrowserTabTitles(rows);

    expect(titles.get(browserTabTitleKey("session-1", "tab-1"))).toBe(
      "Checkout",
    );
  });

  it("reports the epics a browser puts on the page", () => {
    const rows = build(
      [epic({ epicId: "epic-a" })],
      NO_IDENTITIES,
      NO_PREVIOUS,
    );
    expect(Array.from(epicIdsWithBrowsers(rows))).toEqual(["epic-a"]);
  });
});
