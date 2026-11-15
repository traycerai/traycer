import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// When the bot tab opens (T186): it shows its tree once the signed-in
// account's own drafts have been read, and a read that fails must not keep it
// from opening. The page is the production tab over a fake host, with the
// drafts bridge the app mounts above every tab; the page's own storage is the
// drafts' storage, so each case sets it up, or breaks it, before the tab's
// first read.

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

const BOT_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W8Y";
const CHANNEL_BOX = `channel-${BOT_ID}`;
/** The account the page signs in as. */
const FIRST_USER = "user-fixture-1";
const OTHER_USER = "user-admission-other";
const IMAGE_HASH = "ab".repeat(32);

const CONNECTING = '[data-testid="bot-tab-connecting"]';
const BOX_EDITOR =
  '[data-testid="bot-channel-composer-input"] [data-composer-editor]';

/** The tab is open: past its connecting state, with the Channel actions badge showing its one task. */
async function expectTabOpen(page: Page): Promise<void> {
  await expect(
    page.getByTestId("bot-channel-actions-activity-count"),
  ).toHaveText("1");
  await expect(page.locator(CONNECTING)).toHaveCount(0);
}

function boxEditor(page: Page): Locator {
  return page.locator(BOX_EDITOR);
}

/** The key the account's drafts are stored under, taken from the app's own builder. */
async function draftsKey(page: Page, userId: string): Promise<string> {
  const key: unknown = await page.evaluate(`(async () => {
    const keys = await import("/src/lib/persist/keys.ts");
    return keys.botBoxDraftsKey(${JSON.stringify(userId)});
  })()`);
  if (typeof key !== "string")
    throw new Error("the drafts key is not a string");
  return key;
}

/** Stores a draft of the channel's box for the account, as a past run of the app left it. */
async function storeChannelDraft(
  page: Page,
  userId: string,
  text: string,
  image: string | null,
): Promise<void> {
  const key = await draftsKey(page, userId);
  await page.evaluate(
    ([storageKey, botId, boxKey, draftText, hash]) => {
      const paragraph: Array<Record<string, unknown>> = [
        { type: "text", text: draftText },
      ];
      if (hash !== null) {
        paragraph.push({ type: "imageAttachment", attrs: { hash } });
      }
      const content = {
        type: "doc",
        content: [{ type: "paragraph", content: paragraph }],
      };
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          state: {
            threadBoxes: {
              [botId]: { [boxKey]: { text: draftText, content, seedId: 0 } },
            },
          },
          version: 1,
        }),
      );
    },
    [key, BOT_ID, CHANNEL_BOX, text, image] as const,
  );
}

test("opens with an empty channel box on a first run, with nothing stored", async ({
  page,
}) => {
  await page.goto(fixture("bot-compact-actions-menu"));

  await expectTabOpen(page);
  await expect(boxEditor(page)).toBeVisible();
  await expect(boxEditor(page)).toHaveText("");
});

test("opens with an empty channel box when the storage refuses the drafts read", async ({
  page,
}) => {
  // Every read of a drafts key is refused, as storage does when it is blocked.
  await page.addInitScript(`(() => {
    window.__draftReadsRefused = 0;
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (String(key).includes("bot-box-drafts")) {
        window.__draftReadsRefused += 1;
        throw new DOMException("blocked", "SecurityError");
      }
      return original.call(this, key);
    };
  })()`);
  await page.goto(fixture("bot-compact-actions-menu"));

  await expectTabOpen(page);
  await expect(boxEditor(page)).toBeVisible();
  await expect(boxEditor(page)).toHaveText("");
  // The read the tab opened past was refused.
  await expect
    .poll(() => page.evaluate("window.__draftReadsRefused"))
    .toBeGreaterThan(0);
});

test("opens with the draft's text and no image when a stored image cannot be read back", async ({
  page,
}) => {
  await page.goto(fixture("bot-compact-actions-menu"));
  await expectTabOpen(page);
  await storeChannelDraft(page, FIRST_USER, "kept text", IMAGE_HASH);
  // The image database cannot be opened: each open of it throws.
  await page.addInitScript(`(() => {
    window.__imageDatabaseOpens = 0;
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      if (String(name).endsWith(":landing-images")) {
        window.__imageDatabaseOpens += 1;
        throw new DOMException("failing", "UnknownError");
      }
      return version === undefined ? original.call(this, name) : original.call(this, name, version);
    };
  })()`);
  await page.reload();

  await expectTabOpen(page);
  await expect(boxEditor(page)).toHaveText("kept text");
  await expect(boxEditor(page).locator("img")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate("window.__imageDatabaseOpens"))
    .toBeGreaterThan(0);
});

test("opens under the new account after an account switch, and its channel box shows none of the first account's draft", async ({
  page,
}) => {
  await page.goto(fixture("bot-compact-actions-menu"));
  await expectTabOpen(page);
  await storeChannelDraft(page, FIRST_USER, "first account's draft", null);
  await page.reload();
  await expectTabOpen(page);
  await expect(boxEditor(page)).toHaveText("first account's draft");

  await page.evaluate(`(async () => {
    const auth = await import("/src/stores/auth/auth-store.ts");
    const userId = ${JSON.stringify(OTHER_USER)};
    auth.useAuthStore.getState().setSignedIn(
      { userId, userName: "Other", email: "other@example.invalid" },
      { userId, username: "Other" },
      [],
    );
  })()`);

  // The drafts store now belongs to the new account, which is what lets the tab open for it.
  await expect
    .poll(() =>
      page.evaluate(`(async () => {
        const drafts = await import("/src/stores/bots/bot-drafts-store.ts");
        return drafts.useBotDraftsStore.getState().owner?.userId ?? null;
      })()`),
    )
    .toBe(OTHER_USER);
  await expectTabOpen(page);
  await expect(boxEditor(page)).toBeVisible();
  await expect(boxEditor(page)).toHaveText("");
  await expect(page.getByText("first account's draft")).toHaveCount(0);
});

test.describe("a stored draft whose image read never settles", () => {
  test("opens the tab with the box waiting by its stored text, which Discard replaces with an empty box to type in", async ({
    page,
  }) => {
    await page.goto(fixture("bot-compact-actions-menu"));
    await expectTabOpen(page);
    await storeChannelDraft(page, FIRST_USER, "kept text", IMAGE_HASH);
    // A request none of whose handlers ever fires: the read never ends.
    await page.addInitScript(`(() => {
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, version) {
        if (String(name).endsWith(":landing-images")) return Object.create(null);
        return version === undefined ? original.call(this, name) : original.call(this, name, version);
      };
    })()`);
    await page.reload();

    await expectTabOpen(page);
    const waiting = page.getByTestId("bot-channel-composer-input");
    await expect(waiting).toHaveValue("kept text");
    await expect(waiting).toBeDisabled();
    await expect(page.getByTestId("bot-channel-composer-send")).toBeDisabled();
    await expect(
      page.getByTestId("bot-channel-composer-reading"),
    ).toBeVisible();

    await page.getByTestId("bot-channel-composer-discard").click();

    await expect(page.getByTestId("bot-channel-composer-reading")).toHaveCount(
      0,
    );
    await expect(boxEditor(page)).toHaveText("");
    await boxEditor(page).click();
    await page.keyboard.type("typed after discarding");
    await expect(boxEditor(page)).toHaveText("typed after discarding");
  });
});
