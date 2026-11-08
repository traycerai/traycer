import { expect, test, type Locator, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A tall draft on the Start Page must scroll inside the composer. The grid
// gives the task list its own row with a 12.5rem floor, and the editor caps
// at 40dvh from md up (15rem below md). jsdom has no boxes, so the class
// tokens that used to stand in for this live in the Playwright spec instead.
//
// The fixture is the row-scroll page plus `ThemeProvider`. Without that
// provider the phone toolbar's options sheet throws and the start page never
// paints. Recent history is on, so the task list is mounted at a desktop width.

const DESKTOP = { width: 1280, height: 800 } as const;
const PHONE = { width: 390, height: 844 } as const;
const TASK_FLOOR_PX = 200;
const PHONE_EDITOR_CAP_PX = 240;
const LINE_COUNT = 80;

const VISIBLE =
  '[data-surface-kind="draft"][data-visible="true"] [data-testid="landing-draft-surface"]';
const EDITOR = `${VISIBLE} [data-testid="composer-editor"]`;
const TASKS = `${VISIBLE} [data-testid="current-tasks-section"]`;
const COMPOSER = `${VISIBLE} [data-composer-placement]`;
const GRID = `${VISIBLE} .landing-appearance-surface`;

const BoxSchema = z.object({
  top: z.number(),
  bottom: z.number(),
  height: z.number(),
});
const StackSchema = z.object({
  wrapper: BoxSchema,
  composer: BoxSchema,
});
type Stack = z.infer<typeof StackSchema>;

const EditorMetricsSchema = z.object({
  clientHeight: z.number(),
  scrollHeight: z.number(),
  innerHeight: z.number(),
});
type EditorMetrics = z.infer<typeof EditorMetricsSchema>;

async function openEditor(page: Page): Promise<Locator> {
  await page.goto(fixture("landing-draft-surface-cap"));
  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(`${EDITOR} p.is-editor-empty`)).toBeVisible();
  await nextFrames(page, 2);
  return editor;
}

/**
 * Enter submits the composer, so a newline in `pressSequentially` would send
 * the draft. `fill` inserts the text, newlines included, without that key.
 */
async function typeTallDraft(editor: Locator): Promise<void> {
  const draft = Array.from({ length: LINE_COUNT }, () => "line").join("\n");
  await editor.click();
  await editor.fill(draft);
}

async function editorMetrics(page: Page): Promise<EditorMetrics> {
  return EditorMetricsSchema.parse(
    await page.evaluate((selector: string) => {
      const editor = document.querySelector(selector);
      if (!(editor instanceof HTMLElement)) {
        throw new Error("the composer editor is missing");
      }
      return {
        clientHeight: editor.clientHeight,
        scrollHeight: editor.scrollHeight,
        innerHeight: window.innerHeight,
      };
    }, EDITOR),
  );
}

async function readStack(page: Page): Promise<Stack> {
  return StackSchema.parse(
    await page.evaluate(
      (selectors: {
        readonly tasks: string;
        readonly composer: string;
        readonly grid: string;
      }) => {
        const section = document.querySelector(selectors.tasks);
        const composer = document.querySelector(selectors.composer);
        const grid = document.querySelector(selectors.grid);
        if (section === null || composer === null || grid === null) {
          throw new Error("the task list, composer or grid is missing");
        }
        // Providers between the section and its grid row do not have to be
        // elements. The wrapper is the grid's own child.
        let wrapper: HTMLElement | null =
          section.parentElement instanceof HTMLElement
            ? section.parentElement
            : null;
        while (wrapper !== null && wrapper.parentElement !== grid) {
          wrapper =
            wrapper.parentElement instanceof HTMLElement
              ? wrapper.parentElement
              : null;
        }
        if (wrapper === null) {
          throw new Error("the task list wrapper is missing");
        }
        const wrapperBox = wrapper.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        return {
          wrapper: {
            top: wrapperBox.top,
            bottom: wrapperBox.bottom,
            height: wrapperBox.height,
          },
          composer: {
            top: composerBox.top,
            bottom: composerBox.bottom,
            height: composerBox.height,
          },
        };
      },
      { tasks: TASKS, composer: COMPOSER, grid: GRID },
    ),
  );
}

async function expectEditorScrollsWithin(
  page: Page,
  cap: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const metrics = await editorMetrics(page);
      return (
        metrics.innerHeight > 0 &&
        metrics.clientHeight <= cap &&
        metrics.scrollHeight > metrics.clientHeight
      );
    })
    .toBe(true);
  const metrics = await editorMetrics(page);
  expect(metrics.clientHeight).toBeLessThanOrEqual(cap);
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("a tall draft scrolls inside the editor and leaves the task list on the page", async ({
    page,
  }) => {
    const editor = await openEditor(page);
    await expect(page.locator(TASKS)).toBeVisible();
    const before = await readStack(page);
    expect(before.wrapper.height).toBeGreaterThan(0);
    expect(before.wrapper.bottom).toBeLessThanOrEqual(DESKTOP.height);

    await typeTallDraft(editor);
    await expectEditorScrollsWithin(page, DESKTOP.height * 0.4);

    const after = await readStack(page);
    expect(after.wrapper.height).toBeGreaterThanOrEqual(TASK_FLOOR_PX);
    expect(after.wrapper.bottom).toBeLessThanOrEqual(DESKTOP.height);
    expect(after.composer.bottom).toBeLessThanOrEqual(after.wrapper.top + 1);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("a tall draft stays within the phone editor cap and the task list is not mounted", async ({
    page,
  }) => {
    const editor = await openEditor(page);
    await typeTallDraft(editor);
    await expectEditorScrollsWithin(page, PHONE_EDITOR_CAP_PX);
    await expect(page.getByTestId("current-tasks-section")).toHaveCount(0);
  });
});
