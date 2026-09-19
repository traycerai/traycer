import { beforeEach, describe, expect, it } from "vitest";
import { chatSearchDateRange } from "@/lib/chat-search/chat-search-results";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The injected clock: every writer takes `now`, so tests advance it by hand. */
const MONDAY = 1_700_000_000_000;

function store() {
  return useChatSearchStore.getState();
}

/** What the request's date filter would carry right now. */
function lowerBound(): number | null {
  const state = store();
  return (
    chatSearchDateRange(state.datePreset, state.dateAnchorMs)?.from ?? null
  );
}

beforeEach(() => {
  store().resetForTests();
});

describe("chat search store: date anchor", () => {
  it("re-anchors a relative preset when the dialog is reopened, without changing the preset", () => {
    store().setOpen(true, MONDAY);
    store().setDatePreset("day", MONDAY);
    expect(lowerBound()).toBe(MONDAY - DAY_MS);

    store().setOpen(false, MONDAY + 60_000);
    const wednesday = MONDAY + 2 * DAY_MS;
    store().setOpen(true, wednesday);

    // The label is unchanged - the filters survive a close on purpose - but
    // "Past day" now means the day before the REOPEN.
    expect(store().datePreset).toBe("day");
    expect(lowerBound()).toBe(wednesday - DAY_MS);
  });

  it("re-anchors through the chord's toggle as well as through setOpen", () => {
    store().setDatePreset("week", MONDAY);
    store().toggleOpen(MONDAY);
    expect(store().open).toBe(true);
    expect(store().dateAnchorMs).toBe(MONDAY);

    store().toggleOpen(MONDAY + 60_000);
    expect(store().open).toBe(false);
    const later = MONDAY + 5 * DAY_MS;
    store().toggleOpen(later);

    expect(store().open).toBe(true);
    expect(store().dateAnchorMs).toBe(later);
    expect(lowerBound()).toBe(later - 7 * DAY_MS);
  });

  it("holds the anchor still while the dialog stays open", () => {
    store().setDatePreset("day", MONDAY);
    store().setOpen(true, MONDAY);

    // A redundant open, and the filter edits a search does while it is open:
    // none of them may move the window the request is paging against.
    store().setOpen(true, MONDAY + DAY_MS);
    store().setScope("current-task");
    store().setRoleFilter("human");

    expect(store().dateAnchorMs).toBe(MONDAY);
    expect(lowerBound()).toBe(MONDAY - DAY_MS);
  });

  it("leaves the anchor where it is when the dialog closes", () => {
    store().setDatePreset("day", MONDAY);
    store().setOpen(true, MONDAY);
    store().setOpen(false, MONDAY + 3 * DAY_MS);

    expect(store().dateAnchorMs).toBe(MONDAY);
  });

  it("sends no date filter under the 'any' preset, however the anchor moves", () => {
    store().setOpen(true, MONDAY);
    expect(store().datePreset).toBe("any");
    expect(lowerBound()).toBe(null);
  });
});

describe("chat search store: dialog hand-off", () => {
  it("parks the query, opens the dialog, and re-anchors the date presets", () => {
    store().openWith({ query: "release notes", scope: "current-task" }, MONDAY);

    expect(store().open).toBe(true);
    expect(store().scope).toBe("current-task");
    expect(store().dateAnchorMs).toBe(MONDAY);
    expect(store().initialQuery).toBe("release notes");
  });

  it("clears the parked query on consumeInitialQuery, leaving open and scope alone", () => {
    store().openWith({ query: "release notes", scope: "current-task" }, MONDAY);
    store().consumeInitialQuery();

    expect(store().initialQuery).toBeNull();
    expect(store().open).toBe(true);
    expect(store().scope).toBe("current-task");
  });

  it("never parks a query through toggleOpen or setOpen", () => {
    store().setOpen(true, MONDAY);
    expect(store().initialQuery).toBeNull();

    store().setOpen(false, MONDAY + 60_000);
    expect(store().initialQuery).toBeNull();

    store().toggleOpen(MONDAY + 2 * DAY_MS);
    expect(store().initialQuery).toBeNull();
  });

  it("parks a new query and re-anchors even while the dialog is already open", () => {
    store().setOpen(true, MONDAY);
    store().setDatePreset("day", MONDAY);

    const wednesday = MONDAY + 2 * DAY_MS;
    store().openWith(
      { query: "second query", scope: "all-accessible-tasks" },
      wednesday,
    );

    expect(store().open).toBe(true);
    expect(store().scope).toBe("all-accessible-tasks");
    expect(store().dateAnchorMs).toBe(wednesday);
    expect(store().initialQuery).toBe("second query");
    expect(lowerBound()).toBe(wednesday - DAY_MS);
  });

  it("clears a parked query on resetForTests", () => {
    store().openWith({ query: "release notes", scope: "current-task" }, MONDAY);
    store().resetForTests();

    expect(store().initialQuery).toBeNull();
  });
});
