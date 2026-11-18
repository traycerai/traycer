import { expect, type Page } from "@playwright/test";

/** Where the group sits: a title row of a channel or Threads header, or a row of its own. */
type GroupPlacement = "none" | "row" | "reserved" | "header" | "other";

export interface GroupFrame {
  readonly placement: GroupPlacement;
  /** How many Music playback groups the page holds. */
  readonly groups: number;
  readonly groupTop: number;
  /** Where what sits below the title row starts. */
  readonly belowTop: number;
}

declare global {
  interface Window {
    __groupFrames?: GroupFrame[];
    /** Set by the fixture's first commit. */
    __fixtureCommitted?: boolean;
  }
}

/**
 * Records the group's place and the top of what sits below its title row on
 * EVERY frame from the first after the fixture's first commit
 * (`window.__fixtureCommitted`), and none before it. Install it before the
 * page loads.
 */
export async function recordGroupFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const GROUP = '[role="group"][aria-label="Music playback"]';
    const frames: GroupFrame[] = [];
    window.__groupFrames = frames;
    const placementIn = (header: Element | null): GroupPlacement => {
      if (header === null) return "row";
      if (header.closest('[data-testid="bot-threads-view"]') !== null) {
        return "header";
      }
      const id = header.getAttribute("data-testid");
      if (id === "bot-channel-opening-header") return "reserved";
      return id === "bot-channel-header" ? "header" : "other";
    };
    const sample = (): void => {
      if (window.__fixtureCommitted === true) {
        const group = document.querySelector(GROUP);
        const groups = document.querySelectorAll(GROUP).length;
        if (group === null) {
          frames.push({ placement: "none", groups, groupTop: 0, belowTop: 0 });
        } else {
          const header = group.closest("header");
          const below =
            header === null ? group : (header.nextElementSibling ?? group);
          frames.push({
            placement: placementIn(header),
            groups,
            groupTop: group.getBoundingClientRect().top,
            belowTop:
              header === null
                ? below.getBoundingClientRect().bottom
                : below.getBoundingClientRect().top,
          });
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

export async function groupFramesSince(
  page: Page,
  from: number,
): Promise<GroupFrame[]> {
  return page.evaluate(
    (start) => (window.__groupFrames ?? []).slice(start),
    from,
  );
}

/**
 * Exactly one group on every frame, never in a row of its own, and the
 * group's top and the top of what sits below the title row are the same on
 * every frame.
 */
export function expectSteadyFrames(frames: readonly GroupFrame[]): void {
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.filter((f) => f.groups !== 1)).toEqual([]);
  expect(frames.filter((f) => f.placement === "row")).toEqual([]);
  expect([...new Set(frames.map((f) => f.groupTop))]).toHaveLength(1);
  expect([...new Set(frames.map((f) => f.belowTop))]).toHaveLength(1);
}
