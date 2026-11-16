import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's Activity tab lists its tasks, each row a parent the
// way the Chats panel draws one: a chevron, the rolled-up glyph, the title
// with its badges and the state line under it, all one open button. On a
// phone the title and the line give way (they truncate or wrap) and nothing
// else does: the page never scrolls sideways and every row's open button
// stays inside the pane, with a long title, an `every` badge and "Needs you"
// in the same row.
//
// jsdom lays nothing out; this renders the production page against the real
// stylesheet at a phone's width and reads the boxes back.

const PAGE = '[data-testid="bot-activity-page"]';
const ACTIVE_ROW = '[data-testid="bot-activity-task"]';
const ENDED_ROW = '[data-testid="bot-activity-ended-task"]';
const OPEN = '[data-testid="bot-activity-task-open"]';
const CHEVRON = '[data-testid="bot-activity-task-chevron"]';

const ReadingSchema = z.object({
  pageScrollWidth: z.number(),
  pageClientWidth: z.number(),
  pageRight: z.number(),
  openRights: z.array(z.number()),
});

test.use({ viewport: { width: 360, height: 780 } });

test("no row pushes the page sideways or its open button out of the pane on a phone", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  await expect(page.locator(ACTIVE_ROW)).toHaveCount(3);
  await expect(page.locator(ENDED_ROW)).toHaveCount(2);
  const rows = page.locator(`${ACTIVE_ROW}, ${ENDED_ROW}`);
  await expect(rows).toHaveCount(5);
  for (const title of [
    "Release notes draft for 1.9",
    "Nightly flake roster",
    "iPad switcher scroller layer fix",
    "Weekly dependency sweep",
    "Slack uninstall copy",
  ]) {
    await expect(rows.filter({ hasText: title })).toHaveCount(1);
  }
  await nextFrames(page, 2);
  const reading = ReadingSchema.parse(
    await page.evaluate(
      (selectors: { readonly page: string; readonly open: string }) => {
        const pane = document.querySelector(selectors.page);
        if (pane === null) throw new Error(`no ${selectors.page}`);
        return {
          pageScrollWidth: pane.scrollWidth,
          pageClientWidth: pane.clientWidth,
          pageRight: pane.getBoundingClientRect().right,
          openRights: [...document.querySelectorAll(selectors.open)].map(
            (el) => el.getBoundingClientRect().right,
          ),
        };
      },
      { page: PAGE, open: OPEN },
    ),
  );
  expect(reading.pageScrollWidth).toBeLessThanOrEqual(reading.pageClientWidth);
  expect(reading.openRights).toHaveLength(5);
  for (const right of reading.openRights) {
    expect(right).toBeLessThanOrEqual(reading.pageRight);
  }
});

// Where the person's focus goes when the control it is on leaves the page. A
// focused agent leaves through the task store's own update (the page is not
// rendered again), in two orders: the removal while focus is still on the agent,
// and a removal after focus was let go of with nothing else focused. The first
// hands focus to the task's open button; the second must not move focus at all.
// Each case records the focus events and the active element around the removal,
// so a failure says whether focus was let go of or taken by the removal.
const RELEASE_ROW = `${ACTIVE_ROW}[data-task-id="task-release"]`;
const WRITER = '[data-agent-id="agent-writer"]';

const FocusRecordSchema = z.object({
  events: z.array(
    z.object({
      phase: z.string(),
      type: z.string(),
      target: z.string(),
      targetConnected: z.boolean().nullable(),
      relatedTarget: z.string(),
      active: z.string(),
    }),
  ),
  snapshots: z.array(z.object({ label: z.string(), active: z.string() })),
});

/** Records every focus event and, on request, the active element, in the page. */
async function recordFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const describe = (node: EventTarget | null): string => {
      if (node === null) return "null";
      if (node === document) return "document";
      if (node === document.body) return "body";
      if (!(node instanceof Element)) return "other";
      const id =
        node.getAttribute("data-agent-id") ??
        node.getAttribute("data-testid") ??
        node.getAttribute("aria-label") ??
        "";
      return `${node.tagName.toLowerCase()}[${id}]${node.isConnected ? "" : " (detached)"}`;
    };
    const events: Array<Record<string, unknown>> = [];
    const snapshots: Array<Record<string, unknown>> = [];
    const state = { phase: "setup" };
    for (const type of ["focusin", "focusout", "focus", "blur"]) {
      document.addEventListener(
        type,
        (event) => {
          events.push({
            phase: state.phase,
            type,
            target: describe(event.target),
            targetConnected:
              event.target instanceof Node ? event.target.isConnected : null,
            relatedTarget:
              event instanceof FocusEvent
                ? describe(event.relatedTarget)
                : "n/a",
            active: describe(document.activeElement),
          });
        },
        true,
      );
    }
    const snapshot = (label: string): void => {
      snapshots.push({ label, active: describe(document.activeElement) });
    };
    Object.defineProperty(window, "focusProbe", {
      value: {
        events,
        snapshots,
        snapshot,
        setPhase: (phase: string): void => {
          state.phase = phase;
        },
      },
    });
  });
}

async function focusAgentIn(
  page: Page,
  rowSelector: string,
  agentId: string,
): Promise<void> {
  const agent = `[data-agent-id="${agentId}"]`;
  await page.locator(rowSelector).locator(CHEVRON).click();
  await expect(page.locator(agent)).toHaveCount(1);
  await page.evaluate((selector: string) => {
    const found = document.querySelector(selector);
    const button =
      found instanceof HTMLButtonElement
        ? found
        : found?.querySelector("button");
    if (!(button instanceof HTMLButtonElement))
      throw new Error("the agent has no button");
    button.focus();
  }, agent);
}

async function focusWriter(page: Page): Promise<void> {
  await focusAgentIn(page, RELEASE_ROW, "agent-writer");
}

/** Removes the writer through the store, reading focus on each side of it. */
async function removeWriter(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const remove: unknown = Reflect.get(window, "removeReleaseAgent");
    const probe: unknown = Reflect.get(window, "focusProbe");
    if (typeof remove !== "function")
      throw new Error("the fixture has no removeReleaseAgent");
    const snapshot: unknown = Reflect.get(Object(probe), "snapshot");
    const setPhase: unknown = Reflect.get(Object(probe), "setPhase");
    if (typeof snapshot !== "function" || typeof setPhase !== "function")
      throw new Error("no focus probe");
    Reflect.apply(snapshot, probe, ["before removal"]);
    Reflect.apply(setPhase, probe, ["removal"]);
    Reflect.apply(remove, window, ["agent-writer"]);
    Reflect.apply(snapshot, probe, ["right after the store update"]);
    await Promise.resolve();
    Reflect.apply(snapshot, probe, ["after a microtask"]);
    Reflect.apply(setPhase, probe, ["after"]);
  });
  await nextFrames(page, 2);
  await page.evaluate(() => {
    const probe: unknown = Reflect.get(window, "focusProbe");
    const snapshot: unknown = Reflect.get(Object(probe), "snapshot");
    if (typeof snapshot !== "function") throw new Error("no focus probe");
    Reflect.apply(snapshot, probe, ["after two frames"]);
  });
}

/** What the page recorded, printed so a failing run says what happened. */
async function readFocusRecord(
  page: Page,
): Promise<z.infer<typeof FocusRecordSchema>> {
  const record = FocusRecordSchema.parse(
    await page.evaluate(() => {
      const probe: unknown = Reflect.get(window, "focusProbe");
      const events: unknown = Reflect.get(Object(probe), "events");
      const snapshots: unknown = Reflect.get(Object(probe), "snapshots");
      return { events, snapshots };
    }),
  );
  const text = JSON.stringify(record, null, 2);
  await test.info().attach("focus-record", {
    body: text,
    contentType: "application/json",
  });
  console.warn(text);
  return record;
}

/** Names where focus is: the body, a row's open button, the Activity section. */
async function describeActiveIn(
  page: Page,
  rowSelector: string,
): Promise<string> {
  return page.evaluate(
    (selectors: { readonly row: string; readonly page: string }) => {
      const active = document.activeElement;
      if (active === document.body) return "body";
      if (
        active ===
        document.querySelector(
          `${selectors.row} [data-testid="bot-activity-task-open"]`,
        )
      )
        return "the task's open button";
      if (active === document.querySelector(selectors.page))
        return "the Activity section";
      return active === null ? "null" : active.tagName.toLowerCase();
    },
    { row: rowSelector, page: PAGE },
  );
}

async function describeActive(page: Page): Promise<string> {
  return describeActiveIn(page, RELEASE_ROW);
}

test("a focused agent that leaves through the task store hands focus to the task's open button", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  await recordFocus(page);
  await focusWriter(page);

  await removeWriter(page);

  await readFocusRecord(page);
  await expect(page.locator(WRITER)).toHaveCount(0);
  expect(await describeActive(page)).toBe("the task's open button");
});

test("focus let go of in the same turn as the agent's removal through the task store stays on the body", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  await recordFocus(page);
  await focusWriter(page);

  // One script turn: the person's blur, then the store update, with no
  // microtask between them, so the page commits the removal after the blur.
  await page.evaluate(() => {
    const remove: unknown = Reflect.get(window, "removeReleaseAgent");
    if (typeof remove !== "function")
      throw new Error("the fixture has no removeReleaseAgent");
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    Reflect.apply(remove, window, ["agent-writer"]);
  });
  await nextFrames(page, 2);

  await readFocusRecord(page);
  await expect(page.locator(WRITER)).toHaveCount(0);
  expect(await describeActive(page)).toBe("body");
});

test("focus let go of before the agent leaves through the task store stays on the body", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  await recordFocus(page);
  await focusWriter(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  expect(await describeActive(page)).toBe("body");

  await removeWriter(page);

  await readFocusRecord(page);
  await expect(page.locator(WRITER)).toHaveCount(0);
  expect(await describeActive(page)).toBe("body");
});

// The other boundaries, each through a real producer and with nothing in the
// spec rendering the page again: the negotiated methods that gate the
// reporting control, an agent of a task whose reporting trigger is present,
// and a row that leaves because the activity plane stops listing it.
const ROSTER_ROW = `${ACTIVE_ROW}[data-task-id="task-roster"]`;
const REPORT_METHODS = [
  "bot.task.runNow",
  "bot.task.setPaused",
  "bot.task.stop",
];

async function callHook(
  page: Page,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<void> {
  await page.evaluate(
    (call: {
      readonly name: string;
      readonly args: ReadonlyArray<unknown>;
    }) => {
      const hook: unknown = Reflect.get(window, call.name);
      if (typeof hook !== "function")
        throw new Error(`the fixture has no ${call.name}`);
      Reflect.apply(hook, window, call.args);
    },
    { name, args },
  );
}

test("a focused reporting trigger whose methods are lost through the negotiated manifest hands focus to the task's open button", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  await callHook(page, "offerBotTaskMethods", [REPORT_METHODS]);
  const trigger = page
    .locator(ROSTER_ROW)
    .getByRole("button", { name: "Reporting actions" });
  await expect(trigger).toHaveCount(1);
  await recordFocus(page);
  await trigger.focus();

  await callHook(page, "offerBotTaskMethods", [[]]);
  await nextFrames(page, 2);

  await readFocusRecord(page);
  await expect(trigger).toHaveCount(0);
  expect(await describeActiveIn(page, ROSTER_ROW)).toBe(
    "the task's open button",
  );
});

test("a focused agent of a task whose reporting trigger is present hands focus to the task's open button when it leaves through the task store", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  await callHook(page, "offerBotTaskMethods", [REPORT_METHODS]);
  await expect(
    page.locator(ROSTER_ROW).getByRole("button", { name: "Reporting actions" }),
  ).toHaveCount(1);
  await recordFocus(page);
  await focusAgentIn(page, ROSTER_ROW, "agent-shard-b");

  await callHook(page, "removeRosterAgent", ["agent-shard-b"]);
  await nextFrames(page, 2);

  await readFocusRecord(page);
  await expect(page.locator('[data-agent-id="agent-shard-b"]')).toHaveCount(0);
  await expect(
    page.locator(ROSTER_ROW).getByRole("button", { name: "Reporting actions" }),
  ).toHaveCount(1);
  expect(await describeActiveIn(page, ROSTER_ROW)).toBe(
    "the task's open button",
  );
});

test("a focused row that leaves through the activity plane alone hands focus to the Activity section", async ({
  page,
}) => {
  await page.goto(`${fixture("bot-activity-tab")}?working=1`);
  const row = page.locator(`${ACTIVE_ROW}[data-task-id="task-working"]`);
  await expect(row).toHaveCount(1);
  await recordFocus(page);
  await row.locator(OPEN).focus();

  await callHook(page, "endWorkingRow", []);
  await nextFrames(page, 2);

  await readFocusRecord(page);
  await expect(row).toHaveCount(0);
  expect(await describeActiveIn(page, ROSTER_ROW)).toBe("the Activity section");
});

// The pane: the real presentation boundary conceals only its own portal host,
// so a focused control in the tab keeps DOM focus when the pane stops being the
// focused one. When a removal lands in that same commit, nothing may be handed
// focus back inside the pane (its focus capture would reactivate it): focus
// ends on the body and the pane stays as it is.
async function paneActivations(page: Page): Promise<number> {
  const count: unknown = await page.evaluate((): unknown =>
    Reflect.get(window, "paneActivations"),
  );
  return z.number().parse(count);
}

test("a row control focused when its pane stops being the focused one in the commit that removes the row leaves focus on the body and the pane unactivated", async ({
  page,
}) => {
  await page.goto(`${fixture("bot-activity-tab")}?working=1&pane=1`);
  const row = page.locator(`${ACTIVE_ROW}[data-task-id="task-working"]`);
  await expect(row).toHaveCount(1);
  await row.locator(OPEN).focus();

  await callHook(page, "unfocusPaneAnd", ["endWorkingRow", []]);
  await nextFrames(page, 2);

  await expect(row).toHaveCount(0);
  expect(await describeActiveIn(page, ROSTER_ROW)).toBe("body");
  expect(await paneActivations(page)).toBe(0);
});

test("a reporting trigger focused when its pane stops being the focused one in the commit that removes its methods leaves focus on the body and the pane unactivated", async ({
  page,
}) => {
  await page.goto(`${fixture("bot-activity-tab")}?pane=1`);
  await callHook(page, "offerBotTaskMethods", [REPORT_METHODS]);
  const trigger = page
    .locator(ROSTER_ROW)
    .getByRole("button", { name: "Reporting actions" });
  await expect(trigger).toHaveCount(1);
  await trigger.focus();

  await callHook(page, "unfocusPaneAnd", ["offerBotTaskMethods", [[]]]);
  await nextFrames(page, 2);

  await expect(trigger).toHaveCount(0);
  expect(await describeActiveIn(page, ROSTER_ROW)).toBe("body");
  expect(await paneActivations(page)).toBe(0);
});

// The host's own chat indicator is the only thing that keeps an archived agent
// listed under its task here, and the host answering it differently is the only
// thing that changes: the row's chat-indicator scope reads it again, while the
// task, its agents, the notifications and the working count stay as they were.
const ARCHIVED = '[data-agent-id="agent-archived"]';

async function openArchivedAgent(page: Page): Promise<void> {
  await page.goto(`${fixture("bot-activity-tab")}?archived=1`);
  await recordFocus(page);
  await focusAgentIn(page, RELEASE_ROW, "agent-archived");
}

test("a focused archived agent that the host's chat indicator no longer lists hands focus to the task's open button", async ({
  page,
}) => {
  await openArchivedAgent(page);

  await callHook(page, "clearArchivedIndicator", []);

  await expect(page.locator(ARCHIVED)).toHaveCount(0);
  await readFocusRecord(page);
  expect(await describeActive(page)).toBe("the task's open button");
});

test("focus let go of before the host's chat indicator stops listing the archived agent stays on the body", async ({
  page,
}) => {
  await openArchivedAgent(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  expect(await describeActive(page)).toBe("body");

  await callHook(page, "clearArchivedIndicator", []);

  await expect(page.locator(ARCHIVED)).toHaveCount(0);
  await readFocusRecord(page);
  expect(await describeActive(page)).toBe("body");
});
