/**
 * What the suites that drive the header's bot picker and the Channel actions
 * menu share: the real phone header over the real surface, the installed
 * app's menu and bar forms, and waits that name the event they are on.
 * The header's own host-backed chrome is stubbed here.
 */
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  installShellForm,
  SHELL_WIDTH_COLUMN_256,
  SHELL_WIDTH_MENU,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";
import { useTracyPlaceStore } from "@/stores/bots/tracy-place-store";

/** The installed app's two forms with no bots column. */
export const FORMS = [
  ["menu", { width: SHELL_WIDTH_MENU, portrait: false }],
  ["bar", { width: SHELL_WIDTH_COLUMN_256, portrait: true }],
] as const;

/**
 * Registers the form, a focused Tracy tab and their cleanup for the describe
 * it is called in. The clock stays the suite's fake one. Radix and vaul close
 * on timers, which `findBy*`/`waitFor` poll for and advance only when Testing
 * Library sees Jest's fake timers, so a `jest` stand-in that advances Vitest's
 * clock is installed for the describe and removed after it.
 */
export function installCompactHeaderLifecycle(): {
  readonly shell: () => ShellFormHarness;
} {
  let shell: ShellFormHarness | null = null;
  beforeEach(() => {
    if (!vi.isFakeTimers()) vi.useFakeTimers();
    Object.defineProperty(globalThis, "jest", {
      configurable: true,
      value: {
        advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
      },
    });
    shell = installShellForm(SHELL_WIDTH_MENU);
    const tracy = { kind: "tracy", id: "tracy" } as const;
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(tracy), ref: tracy }],
      activeItemId: tabItemId(tracy),
      stripOrder: [tracy],
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "jest");
    shell?.dispose();
    shell = null;
    setPhoneLayoutOnly(false);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useTracyPlaceStore.getState().setThreadsShown(false);
  });
  return {
    shell: () => {
      if (shell === null)
        throw new Error("the form is installed in beforeEach");
      return shell;
    },
  };
}

export function userEvents(): UserEvent {
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

// Captured at load, before any test fakes the clock: the guard below must keep
// counting real time, since a hung await never advances a fake one.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

/**
 * Each await goes through here, so a wait that never ends fails naming the
 * event it was waiting for instead of timing the test out.
 */
export async function step<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  let timer: number | NodeJS.Timeout | undefined;
  const stuck = new Promise<never>((_resolve, reject) => {
    timer = realSetTimeout(() => {
      reject(new Error(`stuck awaiting: ${label}`));
    }, 5_000);
  });
  try {
    return await Promise.race([run(), stuck]);
  } finally {
    realClearTimeout(timer);
  }
}

/**
 * Radix hands focus back to a closed menu's trigger from a zero-delay timer
 * queued at unmount. Running what is due now on the fake clock fires it,
 * with no real time passing.
 */
export async function drainZeroDelayTimers(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

let lastMenuItems: ReadonlyArray<string> = [];

/** What the surface holds right now, for a message that says what was missing. */
function surfaceState(): string {
  const pane = screen.queryByTestId("bot-tab-content-pane");
  const ids =
    pane === null
      ? "no bot-tab-content-pane"
      : Array.from(pane.querySelectorAll("[data-testid]"))
          .map((node) => node.getAttribute("data-testid"))
          .join(", ");
  const active = document.activeElement;
  return [
    `threadsShown=${String(useTracyPlaceStore.getState().threadsShown)}`,
    `menu items=[${lastMenuItems.join(" | ")}]`,
    `content-pane testids=[${ids}]`,
    `focused=${active?.getAttribute("data-testid") ?? active?.tagName ?? "nothing"}`,
  ].join("; ");
}

/** The element, or a failure that names what the surface held instead. */
export function required(testId: string): HTMLElement {
  const element = screen.queryByTestId(testId);
  if (element === null) throw new Error(`no ${testId}: ${surfaceState()}`);
  return element;
}

export function actionsTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /^Channel actions/ });
}

export async function openMenu(user: UserEvent): Promise<HTMLElement> {
  await step("click on the Channel actions trigger", () =>
    user.click(actionsTrigger()),
  );
  const menu = await step("the menu to appear", () =>
    screen.findByRole("menu"),
  );
  lastMenuItems = Array.from(menu.querySelectorAll('[role^="menuitem"]')).map(
    (item) => `${item.getAttribute("role") ?? ""}:${item.textContent}`,
  );
  return menu;
}

export async function menuFullyClosed(): Promise<void> {
  await step("the menu to leave the document", () =>
    waitFor(() => expect(screen.queryByRole("menu")).toBeNull()),
  );
  await drainZeroDelayTimers();
}

/** Chooses an item by the pointer, or by Enter on the focused item. */
export async function choose(
  user: UserEvent,
  how: "pointer" | "keyboard",
  item: HTMLElement,
): Promise<void> {
  if (how === "pointer") {
    await step("pointer click on the menu item", () => user.click(item));
    return;
  }
  act(() => item.focus());
  await step("Enter on the focused menu item", () => user.keyboard("{Enter}"));
}

export async function pickerSheetClosed(): Promise<void> {
  await step("the bot picker sheet to leave the document", () =>
    waitFor(
      () => expect(screen.queryByTestId("bot-channel-picker")).toBeNull(),
      { timeout: 3_000 },
    ),
  );
  await drainZeroDelayTimers();
}

export function headerButton(name: RegExp): HTMLElement {
  return within(screen.getByTestId("app-header")).getByRole("button", {
    name,
  });
}

/** Opens a picker from `trigger`, clicks the row of the bot named `title`, and waits for the sheet to close. */
export async function chooseFromPicker(
  user: UserEvent,
  trigger: () => HTMLElement,
  title: string,
): Promise<void> {
  await step("click on the picker's trigger", () => user.click(trigger()));
  const sheet = await step("the bot picker sheet to appear", () =>
    screen.findByTestId("bot-channel-picker"),
  );
  const row = within(sheet)
    .getAllByTestId("bot-channel-row")
    .find((candidate) => candidate.textContent.includes(title));
  if (row === undefined) throw new Error(`no row for ${title}`);
  await step(`click on the ${title} row`, () => user.click(row));
  await pickerSheetClosed();
}

/** Threads, chosen from the header's bot picker, and the sheet closed again. */
export async function showThreadsFromHeader(user: UserEvent): Promise<void> {
  await step("click on the header's bot picker", () =>
    user.click(screen.getByTestId("bot-channel-picker-trigger")),
  );
  const sheet = await step("the bot picker sheet to appear", () =>
    screen.findByTestId("bot-channel-picker"),
  );
  await step("click on the Threads row", () =>
    user.click(within(sheet).getByTestId("bot-channel-threads-row")),
  );
  await pickerSheetClosed();
  expect(useTracyPlaceStore.getState().threadsShown).toBe(true);
  required("bot-threads-view");
}
