import { DEFAULT_PULL_REQUEST_MENTION_FILTER } from "@/lib/composer/mentions";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GithubMentionFilterPopover } from "../github-mention-filter-popover";
import {
  selectGithubMentionFilter,
  useGithubMentionFilterStore,
} from "@/stores/composer/github-mention-filter-store";

/**
 * What this suite proves, stated precisely: the popover renders its radio
 * groups, Escape closes its OWN Radix layer, and the funnel's dot tracks the
 * published selection.
 *
 * It deliberately does NOT claim Escape *containment* - that the mention menu
 * survives. `GithubMentionFilterPopover` takes only `{ filter, onReturnFocus }`
 * and holds no reference to the picker store, so a test asserting the store
 * stayed open would be true by construction and could not fail however the
 * Escape handling changed. Containment, and the editor focus restore, are
 * covered by the hands-on Chromium probe recorded in the execution log; jsdom
 * cannot even focus a ProseMirror contenteditable, so it cannot reach the
 * precondition either behaviour needs.
 */

beforeEach(() => {
  useGithubMentionFilterStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  useGithubMentionFilterStore.getState().resetForTests();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("GithubMentionFilterPopover", () => {
  it("closes its own layer on Escape", async () => {
    const onReturnFocus = vi.fn();
    const user = userEvent.setup();

    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [
            {
              githubHost: "github.com",
              owner: "traycerai",
              repo: "traycer",
            },
            {
              githubHost: "github.com",
              owner: "traycerai",
              repo: "traycer-internal",
            },
          ],
          selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
        }}
        onReturnFocus={onReturnFocus}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));

    // Popover content is mounted (radiogroups for State / Involvement / Repository).
    expect(
      await screen.findByRole("radiogroup", { name: "State" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Involvement" }),
    ).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Repository" })).toBeTruthy();

    // Escape while the popover holds focus. This is Radix closing its own
    // dismissable layer; whether the mention menu behind it survives is the
    // Chromium probe's claim, not this test's.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await flush();

    await waitFor(() => {
      expect(screen.queryByRole("radiogroup", { name: "State" })).toBeNull();
    });
  });

  it("tracks the dot to the PUBLISHED selection, not the raw store", () => {
    // The store holds a repository the scope no longer contains, so the
    // section reconciles it away and its list is unfiltered. The dot has to
    // agree with the LIST: core flows calls it "the tell that a filter is
    // active", and a dot lit over an unfiltered list is simply a lie.
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-1",
      section: "pull-requests",
      filter: {
        state: "open",
        involvement: "everyone",
        repository: {
          githubHost: "github.com",
          owner: "traycerai",
          repo: "detached",
        },
      },
    });

    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [],
          // What the section actually applied, after reconciliation.
          selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
        }}
        onReturnFocus={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(screen.queryByTestId("github-mention-filter-dot")).toBeNull();
  });

  it("shows the active-filter dot for a genuinely non-default selection", () => {
    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [],
          selected: {
            state: "open",
            involvement: "review-requested",
            repository: null,
          },
        }}
        onReturnFocus={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Filter (active)" }),
    ).toBeTruthy();
    expect(screen.getByTestId("github-mention-filter-dot")).toBeTruthy();
  });

  it("checks radios from chrome.selected, not the raw store", async () => {
    // Store still holds the pre-reconcile selection (dead repo + non-default
    // involvement). The list publishes the reconciled value; radios must
    // follow THAT, or the Repository/Involvement groups disagree with the list.
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-1",
      section: "pull-requests",
      filter: {
        state: "merged",
        involvement: "review-requested",
        repository: {
          githubHost: "github.com",
          owner: "traycerai",
          repo: "detached",
        },
      },
    });

    const user = userEvent.setup();
    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [
            {
              githubHost: "github.com",
              owner: "traycerai",
              repo: "traycer",
            },
            {
              githubHost: "github.com",
              owner: "traycerai",
              repo: "traycer-internal",
            },
          ],
          // Reconciled: default state/involvement, no repository.
          selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
        }}
        onReturnFocus={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));

    const openRadio = await screen.findByRole("radio", { name: "Open" });
    expect(openRadio.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "Merged" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("radio", { name: "Everyone" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "Review requested" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("radio", { name: "All repositories" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("forwards a change from the reconciled selection, not the dead store repo", async () => {
    // Dead repository still in the store. List (and chrome.selected) has
    // already reconciled it to null. Changing State must persist repository:
    // null — not re-spread the detached repo into every later write.
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-1",
      section: "pull-requests",
      filter: {
        state: "open",
        involvement: "everyone",
        repository: {
          githubHost: "github.com",
          owner: "traycerai",
          repo: "detached",
        },
      },
    });

    const user = userEvent.setup();
    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [
            {
              githubHost: "github.com",
              owner: "traycerai",
              repo: "traycer",
            },
            {
              githubHost: "github.com",
              owner: "traycerai",
              repo: "traycer-internal",
            },
          ],
          selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
        }}
        onReturnFocus={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(await screen.findByRole("radio", { name: "Merged" }));

    // Read back through the selector rather than reproducing the store's
    // internal key format: a separator change would otherwise make this
    // `undefined` and report the popover as broken.
    const stored = selectGithubMentionFilter(
      useGithubMentionFilterStore.getState(),
      "epic-1",
      "pull-requests",
    );
    expect(stored).toEqual({
      state: "merged",
      involvement: "everyone",
      repository: null,
    });
  });
});
