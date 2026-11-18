import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { FolderLocationControl } from "@/components/home/host-workspace-selector/folder-location-control";
import type { WorkspaceRunItem } from "@/components/home/host-workspace-selector/workspace-run-item";
import { FontPicker } from "@/components/settings/controls/font-picker";
import { ThemePresetPicker } from "@/components/settings/controls/theme-preset-picker";

/**
 * Autofocus gated on the pointer, across the surfaces that open a list with a
 * search field above it.
 *
 * Both arms are pinned for every site because the coarse arm is invisible on
 * every developer's machine: a suite that only asserted "the field is focused"
 * would keep passing after the gate was deleted. The coarse arm also asserts
 * where focus DID land, which is what separates a gate from a regression -
 * declining Radix's open-autofocus without leaving focus somewhere valid takes
 * the surface away from a screen reader.
 *
 * These layers all open from a trigger that survives the open, so leaving
 * focus on that trigger is the correct destination. A dialog raised from a
 * menu that unmounts with it would need focus moved onto its own content
 * instead - see `use-coarse-pointer-open-autofocus.ts`.
 */

/**
 * The global test shim answers every media query with `matches: false`, which
 * is the fine-pointer arm. This narrows the coarse-pointer query alone so the
 * rest of the app's queries keep the shim's answer.
 */
function stubCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => stubCoarsePointer(false));
afterEach(cleanup);

const SUMMARY: WorktreeWorkspaceSummary = {
  workspacePath: "/repo",
  isGitRepo: true,
  repoIdentifier: { owner: "acme", repo: "app" },
  mainBranch: "development",
  worktrees: [
    {
      worktreePath: "/repo",
      branch: "development",
      head: null,
      isMain: true,
      isLocked: false,
    },
    ...Array.from({ length: 6 }, (_unused, index) => ({
      worktreePath: `/wt/feature-${index}`,
      branch: `feature/${index}`,
      head: null,
      isMain: false,
      isLocked: false,
    })),
  ],
  scripts: null,
};

function workspaceRunItem(): WorkspaceRunItem {
  return {
    key: "/repo",
    displayName: "repo",
    displayPath: "/repo",
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: "worktree",
    branchLabel: "feature/new",
    summary: SUMMARY,
    currentIntent: null,
    defaultNewBranchName: "traycer/swift-otter",
    branchPrefixWarning: null,
    repoIdentifier: { owner: "acme", repo: "app" },
    isPrimary: true,
    canChangePrimary: true,
    makePrimaryDisabled: false,
    makePrimaryDisabledReason: null,
    hostClient: null,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: () => undefined,
    onEmit: vi.fn(),
    onLocate: null,
    onMakePrimary: () => undefined,
    onRemove: null,
  };
}

/** Opens the Location menu's "Existing worktree" submenu and returns its search. */
async function openExistingWorktreeSearch(): Promise<HTMLElement> {
  render(
    <FolderLocationControl
      item={workspaceRunItem()}
      uncommittedByPath={new Map()}
      boundaryEl={null}
      readOnly={false}
    />,
  );
  fireEvent.pointerDown(screen.getByLabelText("Choose run location"), {
    button: 0,
    ctrlKey: false,
  });
  const existingWorktree = await screen.findByRole("menuitem", {
    name: "Existing worktree",
  });
  existingWorktree.focus();
  fireEvent.keyDown(existingWorktree, { key: "ArrowRight" });
  return screen.findByRole("textbox", { name: "Search worktrees" });
}

describe("existing-worktree submenu search", () => {
  it("focuses the search when a fine pointer is driving", async () => {
    const search = await openExistingWorktreeSearch();

    // The focus is scheduled in a frame, and then re-asserted on blur while
    // the submenu's own focus restore fights it - so the settled state is what
    // is worth asserting, not the first tick.
    await waitFor(() => expect(document.activeElement).toBe(search));
  });

  it("leaves the search alone on a coarse pointer", async () => {
    stubCoarsePointer(true);
    const search = await openExistingWorktreeSearch();

    expect(document.activeElement).not.toBe(search);
    // Radix's own submenu focus lands on a worktree row and, with the
    // reclaim-on-blur loop standing down alongside the autofocus, stays there.
    // A row is a valid destination inside the submenu; the body is not.
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    // The scroller holding the worktree rows is a plain layout div with no
    // accessible role of its own, so its test id is the only handle on it.
    expect(
      screen
        .getByTestId("folder-location-existing-list")
        .contains(document.activeElement),
    ).toBe(true);
  });
});

describe("settings theme preset picker", () => {
  /**
   * `focusTrigger` is the engine difference this hook turns on. Chromium
   * focuses a button on pointer activation; WebKit does not, and the shipping
   * mobile shell is a WKWebView. Both are exercised because declining is only
   * safe in the first case.
   */
  function openPicker(focusTrigger: boolean): {
    readonly trigger: HTMLElement;
  } {
    render(<ThemePresetPicker value="neutral" onChange={() => undefined} />);
    const trigger = screen.getByRole("button");
    if (focusTrigger) trigger.focus();
    fireEvent.click(trigger);
    return { trigger };
  }

  it("focuses the preset search when a fine pointer is driving", () => {
    openPicker(true);

    expect(document.activeElement).toBe(
      screen.getByLabelText("Search theme presets"),
    );
  });

  it("leaves the preset search alone on a coarse pointer", () => {
    stubCoarsePointer(true);
    const { trigger } = openPicker(true);

    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Search theme presets"),
    );
    // Focus stayed on the still-mounted popover trigger, not on the body.
    expect(document.activeElement).toBe(trigger);
  });

  // The WebKit arm. Declining alone would leave focus on `body`, standing the
  // popover up with focus outside it - no screen-reader announcement and
  // nothing for the focus scope to hold. Focus moves onto the content instead.
  it("moves focus into the popover when the trigger never took it", () => {
    stubCoarsePointer(true);
    openPicker(false);

    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Search theme presets"),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      document.querySelector('[data-slot="popover-content"]'),
    );
  });
});

describe("settings font picker", () => {
  function openPicker(focusTrigger: boolean): {
    readonly trigger: HTMLElement;
  } {
    render(
      <FontPicker
        value={null}
        onChange={() => undefined}
        options={[{ family: "Inter" }]}
        defaultLabel="System Default"
        resetTooltip="Reset font"
        ariaLabel="UI font"
      />,
    );
    const trigger = screen.getByLabelText("UI font");
    if (focusTrigger) trigger.focus();
    fireEvent.click(trigger);
    return { trigger };
  }

  it("focuses the font search when a fine pointer is driving", () => {
    openPicker(true);

    expect(document.activeElement).toBe(
      screen.getByLabelText("Search ui font"),
    );
  });

  it("leaves the font search alone on a coarse pointer", () => {
    stubCoarsePointer(true);
    const { trigger } = openPicker(true);

    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Search ui font"),
    );
    expect(document.activeElement).toBe(trigger);
  });
});
