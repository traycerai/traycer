import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import {
  centreOf,
  fixture,
  nextFrames,
  type Point,
} from "./support/fixtures.ts";

// Drop intent on both strips, in real Chrome with real mouse input: a task's
// middle half splits at once, its near quarter keeps the dragged tab on that
// side, its far quarter passes it; and where the drop lands decides the group
// it ends up in. The zones against real rows and the group's extent are the
// claims only a real pointer on real layout answers. The zones' arithmetic and
// the membership rule are in `strip-drag-model.test.ts`.

test.use({ viewport: { width: 1300, height: 900 } });

const SIDEBAR = `${fixture("side-tab-strip")}?edge=left`;
const TOP_BAR = fixture("tab-recovery");

const stripSchema = z.object({
  items: z.array(z.array(z.string())),
  groups: z.record(z.string(), z.string().nullable()),
});

/** The tabs store's items (each as its tab ids) and each tab's group, as the page holds them. */
async function readStrip(page: Page): Promise<z.infer<typeof stripSchema>> {
  return stripSchema.parse(
    await page.evaluate(`(async () => {
      const { readTabStripLayout } = await import("/src/stores/tabs/store.ts");
      const layout = readTabStripLayout();
      const ids = (item) => item.kind === "tab"
        ? [item.ref.id]
        : [item.left, item.right].flatMap((side) => side.kind === "tab" ? [side.ref.id] : []);
      return {
        items: layout.items.map(ids),
        groups: Object.fromEntries(
          Object.entries(layout.customizations ?? {}).map(([key, value]) => [key.split(":").slice(1).join(":"), value.groupId]),
        ),
      };
    })()`),
  );
}

const rowSchema = z.object({ centre: z.number(), height: z.number() });
const gapSchema = z.object({
  overlay: z.number(),
  before: rowSchema.nullable(),
  after: rowSchema.nullable(),
});

/**
 * The dragged Delta overlay's centre, and the rows drawn just before and just
 * after the gap its tab left, down the strip.
 */
async function readGap(page: Page): Promise<z.infer<typeof gapSchema>> {
  return gapSchema.parse(
    await page.evaluate(`(() => {
      const row = (node) => {
        const box = node.getBoundingClientRect();
        return { centre: box.top + box.height / 2, height: box.height };
      };
      const overlay = document.querySelector('[data-testid="header-tab-drag-overlay"]');
      const frames = [...document.querySelectorAll("[data-strip-item-id]")]
        .sort((a, b) => row(a).centre - row(b).centre);
      const gap = frames.findIndex((n) => n.getAttribute("data-strip-item-id") === "tab:epic:fixture-delta");
      return {
        overlay: row(overlay).centre,
        before: gap > 0 ? row(frames[gap - 1]) : null,
        after: gap >= 0 && gap < frames.length - 1 ? row(frames[gap + 1]) : null,
      };
    })()`),
  );
}

/** A real press on `from` and a drag to `to`, which leaves the button down. */
async function dragTo(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
}

test.describe("the vertical strip", () => {
  async function openSidebar(page: Page): Promise<void> {
    await page.goto(SIDEBAR);
    await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
    await nextFrames(page, 4);
  }

  /**
   * Delta, which is below the group "Work" (Alpha and the Beta | Gamma pair),
   * dragged up until its centre is `into` px into Alpha's row from its bottom
   * edge, on the group's own block.
   */
  async function dragDeltaIntoAlpha(page: Page, into: number): Promise<void> {
    const delta = await centreOf(page.getByTestId("tab-epic-fixture-delta"));
    const alpha = await page
      .getByTestId("tab-epic-fixture-alpha")
      .boundingBox();
    if (alpha === null) throw new Error("no layout");
    await dragTo(page, delta, {
      x: delta.x,
      y: alpha.y + alpha.height - into,
    });
  }

  test("moves a task dropped in another task's near quarter beside it, and puts it in the group it lands in", async ({
    page,
  }) => {
    await openSidebar(page);

    // Alpha's lower quarter, the side Delta comes from.
    await dragDeltaIntoAlpha(page, 3);
    // The drop will join the group: its block brightens and the line is drawn
    // inside it.
    const block = page.getByTestId("side-tab-group-block-fixture-group");
    await expect(block).toHaveAttribute("data-joining", "true");
    // The drawn block is the fill, which grows around the room the drop opens.
    // The block's own box keeps its pre-drag height, and with Delta coming from
    // below the line sits exactly on that old bottom edge, so measuring it
    // passed or failed on sub-pixel rounding.
    await nextFrames(page, 40);
    const fillBox = await page.getByTestId("side-tab-group-fill").boundingBox();
    const lineBox = await page.getByTestId("tab-drop-indicator").boundingBox();
    if (fillBox === null || lineBox === null) throw new Error("no layout");
    expect(lineBox.y).toBeGreaterThan(fillBox.y);
    expect(lineBox.y + lineBox.height).toBeLessThan(fillBox.y + fillBox.height);
    await page.mouse.up();

    // Delta sits after Alpha, inside the group, and is not paired with it.
    const strip = await readStrip(page);
    expect(strip.items.slice(0, 3)).toEqual([
      ["fixture-alpha"],
      ["fixture-delta"],
      ["fixture-beta", "fixture-gamma"],
    ]);
    expect(strip.groups["fixture-delta"]).toBe("fixture-group");
  });

  test("shows the split at once over another task's middle, and splits on the drop", async ({
    page,
  }) => {
    await openSidebar(page);

    const alpha = await page
      .getByTestId("tab-epic-fixture-alpha")
      .boundingBox();
    if (alpha === null) throw new Error("no layout");
    await dragDeltaIntoAlpha(page, alpha.height / 2 - 4);
    // On the first painted frames, with no pause for it.
    await nextFrames(page, 2);
    expect(await page.getByTestId("side-tab-pair-preview").isVisible()).toBe(
      true,
    );
    await page.mouse.up();

    const strip = await readStrip(page);
    expect(strip.items[0]).toEqual(["fixture-alpha", "fixture-delta"]);
  });

  test("keeps a block's header above its rows and its fill around them, for a task dragged in from above", async ({
    page,
  }) => {
    await openSidebar(page);
    // Delta first, above the group "Work".
    await page.evaluate(`(async () => {
      const { useTabsStore } = await import("/src/stores/tabs/store.ts");
      useTabsStore.getState().moveRef({ kind: "epic", id: "fixture-delta" }, 0);
    })()`);
    await nextFrames(page, 4);
    const delta = await centreOf(page.getByTestId("tab-epic-fixture-delta"));
    const alpha = await centreOf(page.getByTestId("tab-epic-fixture-alpha"));

    // Down into the block, between Alpha and the pair after it.
    await dragTo(page, delta, { x: delta.x, y: alpha.y + 40 });
    await expect(
      page.getByTestId("side-tab-group-block-fixture-group"),
    ).toHaveAttribute("data-joining", "true");
    await nextFrames(page, 40);

    const header = await page
      .locator('[data-testid^="side-tab-group-header-"]')
      .boundingBox();
    const fill = await page.getByTestId("side-tab-group-fill").boundingBox();
    const firstRow = await page
      .getByTestId("tab-epic-fixture-alpha")
      .boundingBox();
    const lastRow = await page
      .getByTestId("split-tab-group-fixture-split")
      .boundingBox();
    if (
      header === null ||
      fill === null ||
      firstRow === null ||
      lastRow === null
    ) {
      throw new Error("no layout");
    }
    // No row slides over the header it should have carried along...
    expect(header.y + header.height).toBeLessThanOrEqual(firstRow.y + 0.5);
    // ...and the fill is one block around the header, the rows and the room the
    // drop opens.
    expect(fill.y).toBeLessThanOrEqual(header.y + 0.5);
    expect(fill.y + fill.height).toBeGreaterThanOrEqual(
      lastRow.y + lastRow.height - 0.5,
    );
    await page.mouse.up();
  });

  test("passes a row at its far quarter as it is drawn, for a task dragged down into a block and back out", async ({
    page,
  }) => {
    await openSidebar(page);
    await page.evaluate(`(async () => {
      const { useTabsStore } = await import("/src/stores/tabs/store.ts");
      useTabsStore.getState().moveRef({ kind: "epic", id: "fixture-delta" }, 0);
    })()`);
    await nextFrames(page, 4);
    const delta = await centreOf(page.getByTestId("tab-epic-fixture-delta"));
    const alpha = await centreOf(page.getByTestId("tab-epic-fixture-alpha"));
    const bottom = alpha.y + 120;
    const down = Array.from(
      { length: Math.floor((bottom - delta.y) / 10) },
      (_, i) => delta.y + 10 * (i + 1),
    );
    const sweep = [...down, ...down.toReversed().slice(1), delta.y];

    await page.mouse.move(delta.x, delta.y);
    await page.mouse.down();
    for (const y of sweep) {
      await page.mouse.move(delta.x, y, { steps: 2 });
      await nextFrames(page, 30);
      // A row is passed once the dragged centre reaches its far quarter where
      // it is drawn, and not before: at rest the overlay never reaches past
      // the near three quarters of the rows drawn either side of its gap, in
      // both directions.
      const { overlay, before, after } = await readGap(page);
      expect(overlay).toBeCloseTo(y, 0);
      if (before !== null) {
        expect(overlay).toBeGreaterThanOrEqual(
          before.centre - before.height / 4 - 1,
        );
      }
      if (after !== null) {
        expect(overlay).toBeLessThanOrEqual(
          after.centre + after.height / 4 + 1,
        );
      }
    }
    await page.mouse.up();
  });

  test("takes a task out of its group when it is dropped below the group's block", async ({
    page,
  }) => {
    await openSidebar(page);
    const alpha = await centreOf(page.getByTestId("tab-epic-fixture-alpha"));
    const epsilon = await centreOf(
      page.getByTestId("tab-epic-fixture-epsilon"),
    );

    // Alpha, the group's first task, down to Epsilon's upper edge.
    await dragTo(page, alpha, { x: alpha.x, y: epsilon.y - 12 });
    await page.mouse.up();

    const strip = await readStrip(page);
    expect(strip.groups["fixture-alpha"]).toBeNull();
    expect(strip.groups["fixture-beta"]).toBe("fixture-group");
  });
});

test.describe("an organization's group, as the owner reported it", () => {
  // Idle holds Cookie, the account organization's group "group" with GUI alone
  // in it, React and Start, every task the organization's. React is dragged up
  // until its centre is over the group's header, just above GUI.
  for (const view of [
    { name: "the Activity view", query: "&scene=sections" },
    { name: "the Layered view", query: "" },
  ]) {
    test(`joins a task dragged up into a one-task group in ${view.name}`, async ({
      page,
    }) => {
      await page.goto(
        `${fixture("side-tab-strip")}?edge=left&tasks=idle-group${view.query}`,
      );
      await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
      await nextFrames(page, 4);
      const react = await centreOf(page.getByTestId("tab-epic-fixture-react"));
      const gui = await page.getByTestId("tab-epic-fixture-gui").boundingBox();
      if (gui === null) throw new Error("no layout");

      await dragTo(page, react, { x: react.x, y: gui.y - 6 });
      // The block brightens and the line is drawn inside it, as it is drawn
      // around the room the drop opens.
      const block = page.getByTestId("side-tab-group-block-fixture-group");
      await expect(block).toHaveAttribute("data-joining", "true");
      await nextFrames(page, 30);
      const blockBox = await block
        .getByTestId("side-tab-group-fill")
        .boundingBox();
      const lineBox = await page
        .getByTestId("tab-drop-indicator")
        .boundingBox();
      if (blockBox === null || lineBox === null) throw new Error("no layout");
      expect(lineBox.y).toBeGreaterThan(blockBox.y);
      expect(lineBox.y + lineBox.height).toBeLessThan(
        blockBox.y + blockBox.height,
      );
      await page.mouse.up();

      // React is GUI's group's first task.
      const strip = await readStrip(page);
      expect(strip.groups["fixture-react"]).toBe("fixture-group");
      expect(strip.items.map((item) => item[0])).toEqual([
        "fixture-cookie",
        "fixture-react",
        "fixture-gui",
        "fixture-start",
      ]);
    });
  }
});

test.describe("the Activity view", () => {
  test("joins a task dropped between a group's tasks in its own section", async ({
    page,
  }) => {
    await page.goto(`${fixture("side-tab-strip")}?edge=left&scene=sections`);
    await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
    await nextFrames(page, 4);
    // Idle holds the group "Work"'s Layout and Launch tasks, then React, which
    // is not in a group.
    const layout = await centreOf(page.getByTestId("tab-epic-fixture-layout"));
    const launch = await centreOf(page.getByTestId("tab-epic-fixture-launch"));
    const react = await centreOf(page.getByTestId("tab-epic-fixture-react"));

    await dragTo(page, react, {
      x: react.x,
      y: Math.round((layout.y + launch.y) / 2),
    });
    await page.mouse.up();

    const strip = await readStrip(page);
    expect(strip.groups["fixture-react"]).toBe(strip.groups["fixture-layout"]);
    expect(strip.groups["fixture-react"]).not.toBeNull();
    // Between the two tasks it joined, in the strip's own order.
    const order = strip.items.map((item) => item[0]);
    expect(order.indexOf("fixture-react")).toBe(
      order.indexOf("fixture-launch") - 1,
    );
  });
});

test.describe("the top bar", () => {
  async function bridge(
    page: Page,
    method: string,
    args: ReadonlyArray<unknown>,
  ): Promise<unknown> {
    return page.evaluate(
      async (call: {
        readonly method: string;
        readonly args: ReadonlyArray<unknown>;
      }): Promise<unknown> => {
        const target: unknown = Reflect.get(window, "__traycerTabRecovery");
        const operation: unknown =
          typeof target === "object" && target !== null
            ? Reflect.get(target, call.method)
            : undefined;
        if (typeof operation !== "function")
          throw new Error(`the tab recovery bridge has no ${call.method}`);
        const result: unknown = await Reflect.apply(operation, target, [
          ...call.args,
        ]);
        return result;
      },
      { method, args },
    );
  }

  /** Four tasks, the second alone in a named group; returns their tab ids. */
  async function openTopBar(page: Page): Promise<string[]> {
    await page.goto(TOP_BAR);
    await page.waitForFunction(
      () => Reflect.get(window, "__traycerTabRecovery") !== undefined,
    );
    await bridge(page, "reset", []);
    const tabIds: string[] = [];
    for (let number = 1; number <= 4; number += 1) {
      tabIds.push(
        z.string().parse(await bridge(page, "createTask", [`Task ${number}`])),
      );
    }
    await page.evaluate(`(async () => {
      const { useTabsStore } = await import("/src/stores/tabs/store.ts");
      const actions = useTabsStore.getState();
      const id = actions.createGroup({ kind: "epic", id: ${JSON.stringify(tabIds[1])} });
      if (id === null) throw new Error("no group");
      actions.updateGroup(id, { name: "Group" });
    })()`);
    await expect(page.locator("[data-strip-group-chip]")).toBeVisible();
    await nextFrames(page, 4);
    return tabIds;
  }

  /**
   * The third task, dragged left until its centre is `into` px into the
   * second, which is alone in the group, from the second's right edge: on the
   * group's own outline.
   */
  async function dragThirdIntoGroup(
    page: Page,
    tabIds: ReadonlyArray<string>,
    into: number,
  ): Promise<void> {
    const third = await centreOf(page.getByTestId(`tab-epic-${tabIds[2]}`));
    const second = await page
      .getByTestId(`tab-epic-${tabIds[1]}`)
      .boundingBox();
    if (second === null) throw new Error("no layout");
    await dragTo(page, third, {
      x: second.x + second.width - into,
      y: third.y,
    });
  }

  test("moves a task dropped in a one-task group's task's near quarter beside it, and joins it to the group", async ({
    page,
  }) => {
    const tabIds = await openTopBar(page);

    await dragThirdIntoGroup(page, tabIds, 6);
    // The drop will join the group: the line is drawn on the group's own last
    // tab, not on the ungrouped tab after it.
    await expect(
      page
        .getByTestId(`tab-epic-${tabIds[1]}`)
        .getByTestId("tab-drop-indicator"),
    ).toBeVisible();
    await page.mouse.up();

    // The owner's case: the task joins the group and is not paired with it.
    const strip = await readStrip(page);
    expect(strip.items).toEqual(tabIds.map((id) => [id]));
    expect(strip.groups[tabIds[2]]).toBe(strip.groups[tabIds[1]]);
    expect(strip.groups[tabIds[2]]).not.toBeNull();
  });

  test("shows the split at once over another task's middle, and splits on the drop", async ({
    page,
  }) => {
    const tabIds = await openTopBar(page);
    const second = await page
      .getByTestId(`tab-epic-${tabIds[1]}`)
      .boundingBox();
    if (second === null) throw new Error("no layout");

    await dragThirdIntoGroup(page, tabIds, second.width / 2 - 20);
    // On the first painted frames, with no pause for it, naming the dragged
    // task in the half it will take.
    await nextFrames(page, 2);
    const preview = page.locator('[data-testid^="tab-strip-pair-preview-"]');
    expect(await preview.isVisible()).toBe(true);
    expect(await preview.textContent()).toBe("Task 3");
    await page.mouse.up();

    const strip = await readStrip(page);
    expect(strip.items[1]).toEqual([tabIds[1], tabIds[2]]);
  });

  test("slides a group's chip along with its tabs, for a tab dragged across the group", async ({
    page,
  }) => {
    const tabIds = await openTopBar(page);
    const first = await centreOf(page.getByTestId(`tab-epic-${tabIds[0]}`));
    const third = await centreOf(page.getByTestId(`tab-epic-${tabIds[2]}`));

    // The first task past the group (the second task, alone in it) to the third.
    await dragTo(page, first, { x: third.x - 20, y: first.y });
    await nextFrames(page, 40);

    const chip = await page.locator("[data-strip-group-chip]").boundingBox();
    const second = await page
      .getByTestId(`tab-epic-${tabIds[1]}`)
      .boundingBox();
    if (chip === null || second === null) throw new Error("no layout");
    // The tab that slid into the first task's place carries the chip with it,
    // and does not pass under it.
    expect(chip.x + chip.width).toBeLessThanOrEqual(second.x + 0.5);
    await page.mouse.up();
  });

  test("joins a task dropped into an organization's one-task group, the owner's case", async ({
    page,
  }) => {
    const tabIds = await openTopBar(page);
    // Signed in, the group and every task are the account organization's.
    await page.evaluate(`(async () => {
      const { useTabsStore } = await import("/src/stores/tabs/store.ts");
      const { groups, customizations } = useTabsStore.getState();
      const stamp = (entry) => ({ ...entry, organizationOwnerId: "fixture-user" });
      useTabsStore.setState({
        groups: Object.fromEntries(Object.entries(groups).map(([id, g]) => [id, stamp(g)])),
        customizations: Object.fromEntries(
          ${JSON.stringify(tabIds)}.map((id) => {
            const key = "epic:" + id;
            return [key, stamp(customizations[key] ?? { color: null, icon: null, groupId: null })];
          }),
        ),
      });
    })()`);
    await nextFrames(page, 4);
    const third = await centreOf(page.getByTestId(`tab-epic-${tabIds[2]}`));
    const second = await page
      .getByTestId(`tab-epic-${tabIds[1]}`)
      .boundingBox();
    if (second === null) throw new Error("no layout");

    // Left until the third's centre is over the second's leading part.
    await dragTo(page, third, {
      x: second.x + second.width * 0.15,
      y: third.y,
    });
    await page.mouse.up();

    const strip = await readStrip(page);
    expect(strip.groups[tabIds[2]]).toBe(strip.groups[tabIds[1]]);
    expect(strip.groups[tabIds[2]]).not.toBeNull();
    expect(strip.items.map((item) => item[0])).toEqual([
      tabIds[0],
      tabIds[2],
      tabIds[1],
      tabIds[3],
    ]);
  });

  test("joins a task dropped on a group's chip, as the group's first task", async ({
    page,
  }) => {
    const tabIds = await openTopBar(page);
    const fourth = await centreOf(page.getByTestId(`tab-epic-${tabIds[3]}`));
    const chip = await centreOf(page.locator("[data-strip-group-chip]"));

    await dragTo(page, fourth, { x: chip.x, y: fourth.y });
    await page.mouse.up();

    const strip = await readStrip(page);
    expect(strip.groups[tabIds[3]]).toBe(strip.groups[tabIds[1]]);
    expect(strip.items.map((item) => item[0])).toEqual([
      tabIds[0],
      tabIds[3],
      tabIds[1],
      tabIds[2],
    ]);
  });
});
