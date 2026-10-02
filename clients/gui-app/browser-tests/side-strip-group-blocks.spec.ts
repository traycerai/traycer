import { expect, test, type Locator, type Page } from "@playwright/test";
import { parse, wcagContrast } from "culori";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A tab group's block in the expanded strip, in real Chrome: the claims only
// painted pixels and real layout answer. Which tasks a block holds, its label
// and its count are in `side-tab-strip.test.tsx`; here, that the group's name
// reads on the block's own fill in every palette colour in a dark and a light
// theme (the fill is a `color-mix` over the strip's ground, which jsdom does
// not resolve), the Activity view's label line, and a split pair's inset in the
// rail's column.

test.use({ viewport: { width: 900, height: 900 } });

const LAYERED = `${fixture("side-tab-strip")}?edge=left`;
const ACTIVITY = `${fixture("side-tab-strip")}?edge=left&scene=sections`;

type Scheme = "dark" | "light";

async function openStrip(
  page: Page,
  url: string,
  scheme: Scheme,
): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(url);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await nextFrames(page, 4);
}

/** The group's name on its block, as painted: the name's colour against the block's fill. */
async function nameContrast(block: Locator, name: Locator): Promise<number> {
  const fill = await block.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  const ink = await name.evaluate((node) => getComputedStyle(node).color);
  const blockColor = parse(fill);
  const nameColor = parse(ink);
  if (blockColor === undefined || nameColor === undefined) {
    throw new Error(`cannot read the fill ${fill} or the name colour ${ink}`);
  }
  return wcagContrast(nameColor, blockColor);
}

for (const scheme of ["dark", "light"] as const) {
  test(`reads the Layered view's group name at 4.5:1 on its block in every palette colour in a ${scheme} theme`, async ({
    page,
  }) => {
    await openStrip(page, LAYERED, scheme);
    const block = page.getByTestId("side-tab-group-block-fixture-group");
    const name = block.getByTestId("side-tab-group-name");
    const palette = await page.evaluate<ReadonlyArray<string>>(`(async () => {
      const { TAB_COLORS } = await import("/src/stores/tabs/tab-groups.ts");
      return TAB_COLORS.map((color) => color.value);
    })()`);

    for (const color of palette) {
      await page.evaluate(`(async () => {
        const { useTabsStore } = await import("/src/stores/tabs/store.ts");
        useTabsStore.getState().updateGroup("fixture-group", { color: ${JSON.stringify(color)} });
      })()`);
      // The name is set in the same commit as the fill, before paint.
      await expect
        .poll(() =>
          block.evaluate((node) =>
            node.style.getPropertyValue("--side-tab-group-color"),
          ),
        )
        .toBe(color);
      expect(await nameContrast(block, name), color).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  test(`reads the Activity view's group label at 4.5:1 on its block in a ${scheme} theme`, async ({
    page,
  }) => {
    await openStrip(page, ACTIVITY, scheme);
    const block = page
      .getByTestId("side-tab-group-block-fixture-group")
      .first();

    expect(
      await nameContrast(block, block.getByTestId("side-tab-group-name")),
    ).toBeGreaterThanOrEqual(4.5);
  });
}

test("reads the group's name at 4.5:1 again after the theme changes", async ({
  page,
}) => {
  await openStrip(page, LAYERED, "dark");
  const block = page.getByTestId("side-tab-group-block-fixture-group");
  const name = block.getByTestId("side-tab-group-name");
  const dark = await name.evaluate((node) => getComputedStyle(node).color);

  await page.emulateMedia({ colorScheme: "light" });

  await expect
    .poll(async () => name.evaluate((node) => getComputedStyle(node).color))
    .not.toBe(dark);
  expect(await nameContrast(block, name)).toBeGreaterThanOrEqual(4.5);
});

test("reads the group's name at 4.5:1 once a drag that outlasted a theme change ends", async ({
  page,
}) => {
  await openStrip(page, LAYERED, "dark");
  const block = page.getByTestId("side-tab-group-block-fixture-group");
  const name = block.getByTestId("side-tab-group-name");
  const setPlacements = (placements: string) =>
    page.evaluate(`(async () => {
      const { useEpicDndStore } = await import("/src/components/epic-canvas/dnd/dnd-store.ts");
      useEpicDndStore.getState().headerStripGroupPlacementsChanged(${placements});
    })()`);

  // The block paints no fill of its own while a drag has placed it, only the
  // layer beside it does, so the theme change has no fill to read the name on.
  await setPlacements(
    `[{ groupId: "fixture-group", lane: null, offset: 0, grow: 0, visible: true }]`,
  );
  await expect(block).toHaveAttribute("data-placed", "true");
  await page.emulateMedia({ colorScheme: "light" });
  await nextFrames(page, 4);
  await setPlacements("[]");
  await expect(block).toHaveAttribute("data-placed", "false");

  await expect
    .poll(async () => nameContrast(block, name))
    .toBeGreaterThanOrEqual(4.5);
});

test("draws the Activity view's group label as a 20px line in 11px medium text", async ({
  page,
}) => {
  await openStrip(page, ACTIVITY, "dark");
  const label = page.getByTestId("side-tab-group-label-fixture-group").first();

  const box = await label.boundingBox();
  const type = await label.evaluate((node) => {
    const style = getComputedStyle(node);
    return { size: style.fontSize, weight: style.fontWeight };
  });

  expect(box?.height).toBe(20);
  expect(type).toEqual({ size: "11px", weight: "500" });
});

test("seats a collapsed group's status inside its header row, at the trailing edge and on its centre line", async ({
  page,
}) => {
  await openStrip(page, LAYERED, "dark");
  // Delta carries an unread failure; folding a group of it puts that status
  // on the header.
  await page.evaluate(`(async () => {
    const { useTabsStore } = await import("/src/stores/tabs/store.ts");
    const actions = useTabsStore.getState();
    const id = actions.createGroup({ kind: "epic", id: "fixture-delta" });
    if (id === null) throw new Error("no group");
    actions.updateGroup(id, { name: "Reading", collapsed: true });
  })()`);
  const header = page.locator(
    '[data-testid^="side-tab-group-header-"][data-collapsed="true"]',
  );
  const badge = header.getByTestId("side-tab-group-badge");

  const headerBox = await header.boundingBox();
  const badgeBox = await badge.boundingBox();

  if (headerBox === null || badgeBox === null) throw new Error("no layout");
  // Inside the row's own 8px padding, and level with its centre.
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(
    headerBox.x + headerBox.width - 8 + 0.5,
  );
  expect(badgeBox.y + badgeBox.height / 2).toBeCloseTo(
    headerBox.y + headerBox.height / 2,
    0,
  );
  expect(badgeBox.y).toBeGreaterThanOrEqual(headerBox.y);
});

test("opens the group's editor from a grouped task's menu and keeps it open once the menu has closed", async ({
  page,
}) => {
  await openStrip(page, LAYERED, "dark");
  await page.getByTestId("tab-epic-fixture-alpha").click({ button: "right" });
  await page.getByText("Tab appearance").click();

  await page.getByRole("menuitem", { name: "Edit group…" }).click();

  // The menu keeps its exit animation and takes focus back while it plays; an
  // editor opened over that is dismissed, so it opens after the menu is gone.
  await expect
    .poll(() => page.locator('[data-slot="context-menu-content"]').count())
    .toBe(0);
  await expect(page.getByRole("textbox", { name: "Group name" })).toBeVisible();
});

test("keeps a split pair in a rail column 4px inside it, as its tiles are", async ({
  page,
}) => {
  await openStrip(page, `${LAYERED}&rail=1`, "dark");
  const column = page.getByTestId("side-tab-group-column-fixture-group");
  const columnBox = await column.boundingBox();
  const pairBox = await column
    .getByTestId("split-tab-group-fixture-split")
    .boundingBox();
  const tileBox = await column
    .getByTestId("tab-epic-fixture-alpha")
    .boundingBox();

  if (columnBox === null || pairBox === null || tileBox === null) {
    throw new Error("no layout");
  }
  for (const box of [pairBox, tileBox]) {
    expect(box.x - columnBox.x).toBe(4);
    expect(columnBox.x + columnBox.width - (box.x + box.width)).toBe(4);
  }
});
