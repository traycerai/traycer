import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MentionStepChrome,
  MentionStepChromeRefresh,
} from "@/lib/composer/mentions";

import { MentionStepChromeBar } from "../mention-step-chrome-bar";

/**
 * The refresh button belongs to ONE target.
 *
 * `useRefreshSpinner` holds its own `localRefreshing`, and the button stays
 * mounted while the host, the epic, the folders or the section move underneath
 * it. Without a remount, a refresh issued for the scope the user left holds the
 * new scope's button disabled until that promise settles or its leash expires -
 * 20s for a GitHub sweep, on a request the new scope never made.
 */

function chromeWith(refresh: MentionStepChromeRefresh): MentionStepChrome {
  return {
    refresh,
    freshness: null,
    notice: null,
    filter: null,
    banner: null,
    appendedStatus: null,
    emptyLabel: null,
  };
}

/** A refresh that never settles, so the spinner can only be cleared by a remount. */
function pendingRefresh(targetKey: string): MentionStepChromeRefresh {
  return {
    onRefresh: () => new Promise<void>(() => undefined),
    refreshing: false,
    label: "Refresh pull requests",
    timeoutMs: 20_000,
    targetKey,
  };
}

function refreshButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Refresh pull requests" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected the refresh control to be a button");
  }
  return button;
}

afterEach(() => {
  cleanup();
});

describe("MentionStepChromeBar refresh button", () => {
  it("re-enables when the refresh target changes under a pending refresh", () => {
    const onReturnFocus = vi.fn();
    const { rerender } = render(
      <MentionStepChromeBar
        chrome={chromeWith(pendingRefresh("scope-apull-requests"))}
        onReturnFocus={onReturnFocus}
      />,
    );

    fireEvent.click(refreshButton());
    expect(refreshButton().disabled).toBe(true);

    // The folders change while that refresh is still open. The new scope never
    // asked for anything, so its button must be usable immediately.
    rerender(
      <MentionStepChromeBar
        chrome={chromeWith(pendingRefresh("scope-bpull-requests"))}
        onReturnFocus={onReturnFocus}
      />,
    );

    expect(refreshButton().disabled).toBe(false);
  });

  it("keeps the spinner while the target is unchanged", () => {
    // The control. A re-render for any other reason - a freshness tick, a
    // notice arriving - must not cancel the spinner on a refresh that is still
    // genuinely running.
    const onReturnFocus = vi.fn();
    const refresh = pendingRefresh("scope-apull-requests");
    const { rerender } = render(
      <MentionStepChromeBar
        chrome={chromeWith(refresh)}
        onReturnFocus={onReturnFocus}
      />,
    );

    fireEvent.click(refreshButton());
    expect(refreshButton().disabled).toBe(true);

    rerender(
      <MentionStepChromeBar
        chrome={chromeWith(refresh)}
        onReturnFocus={onReturnFocus}
      />,
    );

    expect(refreshButton().disabled).toBe(true);
  });
});
