/**
 * What the bot box's held-drop suites share: the channel mounted over a
 * stored draft whose image read the case holds, and the fake-clock polling
 * that lets the app settle. The tree and the lifecycle are the question-card
 * harness's.
 */
import { act, screen } from "@testing-library/react";
import { expect, vi } from "vitest";
import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { releaseImageReads } from "@/components/bots/__tests__/bot-drop-image-reads";
import {
  PNG_BYTES,
  storeDraftWithImages,
  storedImageHash,
} from "@/components/bots/__tests__/bot-drop-test-support";
import {
  CHANNEL_ID,
  mountChannel,
  session,
  setIdentityBridge,
} from "@/components/bots/__tests__/bot-channel-question-card-harness";

export const IMAGES_TITLE = FILE_DROP_OVERLAY_CONTENT.images.title;
export const COMPOSER = "bot-channel-composer";
export const READING = `${COMPOSER}-reading`;
export const HELD = `${COMPOSER}-held`;

/** The accounts of the running case, fresh for each so no case reads another's stored drafts. */
export const accounts = { a: "", b: "" };
let accountNumber = 0;

export function newAccounts(): void {
  accountNumber += 1;
  accounts.a = `user-account-a-${String(accountNumber)}`;
  accounts.b = `user-account-b-${String(accountNumber)}`;
}

export function signInAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId,
        userName: userId,
        email: `${userId}@example.com`,
        avatarUrl: null,
      },
      contextMetadata: { userId, username: userId },
    });
  });
}

export function pane(): HTMLElement {
  return screen.getByTestId("bot-channel");
}

export function overlayShown(): boolean {
  return screen.queryAllByText(IMAGES_TITLE).length > 0;
}

/** Lets the app's own work settle on the fake clock, in act, until `check` holds. */
export async function until(check: () => void): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
    }
  }
}

/** The images the box holds, by file name, in the order the strip shows them. */
export function chips(): ReadonlyArray<string> {
  return screen
    .queryAllByRole("button", { name: /^Open Image#\d+:/ })
    .map((chip) =>
      (chip.getAttribute("aria-label") ?? "").replace(/^Open Image#\d+: /, ""),
    );
}

export async function chipsAre(names: ReadonlyArray<string>): Promise<void> {
  await until(() => expect(chips()).toEqual(names));
}

/** The channel mounted over a stored draft whose image read the case holds. */
export async function mountReading(imageCount: number): Promise<{
  readonly hash: string;
  readonly stored: string;
  readonly reopen: (next: BotOpenThread | null) => void;
}> {
  const hash = await storedImageHash();
  signInAs(accounts.a);
  setIdentityBridge(true);
  const stored = storeDraftWithImages(accounts.a, CHANNEL_ID, hash, imageCount);
  session(CHANNEL_ID, []);
  const { reopen } = mountChannel(null);
  await until(() => expect(screen.getByTestId(READING)).toBeTruthy());
  return { hash, stored, reopen };
}

export function release(hash: string): void {
  act(() => releaseImageReads(hash, new Uint8Array(PNG_BYTES)));
}

/** Lets the fake clock run past any read or conversion a misrouted drop would have started. */
export async function settleLong(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
}
