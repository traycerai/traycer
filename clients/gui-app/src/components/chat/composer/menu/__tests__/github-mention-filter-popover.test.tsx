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

  it("returns focus to the composer when Escape closes the popover", async () => {
    // The control for the outside-interaction test below: an ordinary close
    // (the "closes its own layer on Escape" test above pins that Radix's own
    // layer unmounts) must still hand focus back, or the outside-interaction
    // skip added to `onInteractOutside`/`onCloseAutoFocus` would be dead code
    // that never fires either way.
    const onReturnFocus = vi.fn();
    const user = userEvent.setup();

    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [],
          selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
        }}
        onReturnFocus={onReturnFocus}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(
      await screen.findByRole("radiogroup", { name: "State" }),
    ).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await flush();

    await waitFor(() => {
      expect(screen.queryByRole("radiogroup", { name: "State" })).toBeNull();
    });
    expect(onReturnFocus).toHaveBeenCalledWith(null);
  });

  it("does not return focus to the composer when the close came from an outside interaction", async () => {
    // An outside interaction moves focus where the user POINTED (a target
    // rendered outside the popover). Returning the caret to the composer over
    // it would steal focus back from the control the user just chose - the
    // next keystrokes would land in the mention query instead of their target.
    const onReturnFocus = vi.fn();
    const user = userEvent.setup();

    render(
      <>
        <button type="button">Outside target</button>
        <GithubMentionFilterPopover
          filter={{
            section: "pull-requests",
            epicId: "epic-1",
            repositories: [],
            selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
          }}
          onReturnFocus={onReturnFocus}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(
      await screen.findByRole("radiogroup", { name: "State" }),
    ).toBeTruthy();

    const outside = screen.getByRole("button", { name: "Outside target" });
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(outside, { button: 0 });
    fireEvent.pointerUp(outside, { button: 0, pointerType: "mouse" });
    fireEvent.click(outside);
    await flush();

    // The popover actually closed from the outside click - otherwise the
    // assertion below would be vacuously true regardless of what
    // `onInteractOutside`/`onCloseAutoFocus` do.
    await waitFor(() => {
      expect(screen.queryByRole("radiogroup", { name: "State" })).toBeNull();
    });
    expect(onReturnFocus).not.toHaveBeenCalled();
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

  it("keeps a detached repository selection across a State change", async () => {
    // Detached repository still in the store; the list (and chrome.selected)
    // has reconciled it to null AS A DISPLAY FALLBACK. Changing State edits
    // that projection, and writing it back verbatim would turn "remembered
    // while unrepresented" into a permanent delete - the selection has to
    // come back when its folder is re-attached.
    const detached = {
      githubHost: "github.com",
      owner: "traycerai",
      repo: "detached",
    };
    useGithubMentionFilterStore.getState().setFilter({
      epicId: "epic-1",
      section: "pull-requests",
      filter: {
        state: "open",
        involvement: "everyone",
        repository: detached,
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
      repository: detached,
    });
  });

  it("lets the Repository group replace a detached selection outright", async () => {
    // The control for the test above: the preserve rule must not apply to the
    // Repository group's own writes, or the one control that manages the
    // selection would be the one place it cannot be changed.
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

    const inScope = {
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
    };
    const user = userEvent.setup();
    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [
            inScope,
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
    await user.click(await screen.findByRole("radio", { name: "traycer" }));

    const stored = selectGithubMentionFilter(
      useGithubMentionFilterStore.getState(),
      "epic-1",
      "pull-requests",
    );
    expect(stored.repository).toEqual(inScope);
  });

  it("escalates repository radio labels only as far as a collision forces, shared with every row surface", async () => {
    // `repositoryLabel` now switches on `githubRepositoryQualification`
    // rather than restating the escalation - this pins the walk still
    // produces the right label at each step through the popover.
    const user = userEvent.setup();
    render(
      <GithubMentionFilterPopover
        filter={{
          section: "pull-requests",
          epicId: "epic-1",
          repositories: [
            { githubHost: "github.com", owner: "acme", repo: "api" },
            { githubHost: "github.com", owner: "contoso", repo: "api" },
            { githubHost: "ghe.corp", owner: "acme", repo: "widgets" },
            { githubHost: "github.com", owner: "acme", repo: "widgets" },
          ],
          selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
        }}
        onReturnFocus={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));

    // Two repos share the bare name "api" across different owners: both
    // escalate to `owner/repo`.
    expect(await screen.findByRole("radio", { name: "acme/api" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "contoso/api" })).toBeTruthy();

    // "acme/widgets" collides across TWO hosts as well: both escalate all
    // the way to `owner/repo (host)`.
    expect(
      screen.getByRole("radio", { name: "acme/widgets (ghe.corp)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "acme/widgets (github.com)" }),
    ).toBeTruthy();
  });
});
