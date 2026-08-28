import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeBranchPrefixSection } from "@/components/settings/worktree-branch-prefix-section";
import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  useSettingsStore,
} from "@/stores/settings/settings-store";

// Mirrors SAVE_DEBOUNCE_MS / SAVED_FLASH_MS in worktree-branch-prefix-section.tsx.
const SAVE_DEBOUNCE_MS = 500;
const SAVED_FLASH_MS = 1600;

/**
 * Matches a Tailwind `order-*` utility in a SINGLE class token, with or
 * without a variant prefix and with or without the negative marker - Tailwind
 * spells a backwards reorder `-order-1`, so a pattern anchored on the letters
 * alone reads the leading `-` as context and lets it past. Anchoring on token
 * start or a variant colon, with the marker optional, is what closes that.
 * `border-*` and friends never match: their `order-` begins mid-token.
 */
const ORDER_UTILITY = /(?:^|:)-?order-/;

function resetStore(): void {
  window.localStorage.clear();
  useSettingsStore.setState({
    worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
  });
}

function getPrefixInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Branch prefix" });
}

function typePrefix(input: HTMLInputElement, value: string): void {
  // Native focus so Enter → currentTarget.blur() actually dispatches blur in jsdom.
  input.focus();
  fireEvent.change(input, { target: { value } });
}

async function advancePastDebounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
  });
}

function expectQuietChrome(): void {
  expect(
    screen.queryByTestId("worktree-branch-prefix-saving-spinner"),
  ).toBeNull();
  expect(screen.queryByTestId("worktree-branch-prefix-saved-check")).toBeNull();
}

function expectSavingChrome(): void {
  expect(
    screen.getByTestId("worktree-branch-prefix-saving-spinner"),
  ).toBeTruthy();
  expect(screen.queryByTestId("worktree-branch-prefix-saved-check")).toBeNull();
}

function expectSavedCheckChrome(): void {
  expect(screen.getByTestId("worktree-branch-prefix-saved-check")).toBeTruthy();
  expect(
    screen.queryByTestId("worktree-branch-prefix-saving-spinner"),
  ).toBeNull();
}

describe("WorktreeBranchPrefixSection", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    resetStore();
  });

  it("renders the saved prefix in the input", () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "anurag/" });

    render(<WorktreeBranchPrefixSection />);

    expect(getPrefixInput().value).toBe("anurag/");
  });

  it("shows quiet chrome on mount when the draft matches the store", () => {
    render(<WorktreeBranchPrefixSection />);

    // Idle mount is genuinely empty beside the input - no permanent "Saved"
    // text and no spinner/check flash until the user resolves an edit.
    expectQuietChrome();
  });

  it("autosaves a valid prefix after the debounce pause without blurring", async () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "feat-");

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(document.activeElement).toBe(input);

    await advancePastDebounce();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
    expect(input.value).toBe("feat-");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("does not write to the store before the debounce elapses", async () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "feat-");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    });

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(input.value).toBe("feat-");
  });

  it("trims whitespace around a valid prefix before saving on debounce", async () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "  feat-  ");
    await advancePastDebounce();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
    // Draft is normalized to the trimmed value once the commit resolves.
    expect(input.value).toBe("feat-");
  });

  it("allows clearing the prefix via autosave (empty string means no prefix)", async () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "");
    await advancePastDebounce();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("");
  });

  it("never saves invalid values even after the debounce window elapses", async () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "traycer/" });
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "bad prefix");

    expect(screen.getByText("Prefix can't contain spaces.")).toBeTruthy();
    expectQuietChrome();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 3);
    });

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("traycer/");
    expect(input.value).toBe("bad prefix");
    expect(screen.getByText("Prefix can't contain spaces.")).toBeTruthy();
    expectQuietChrome();
  });

  it("wires aria-describedby to the error alert only while invalid", () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    // Valid/empty draft: no describedby and no alert.
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    typePrefix(input, "bad prefix");

    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("Prefix can't contain spaces.");
    expect(error.id.length).toBeGreaterThan(0);
    expect(input.getAttribute("aria-describedby")).toBe(error.id);

    // Back to a valid draft: describedby and alert both clear.
    typePrefix(input, "feat-");
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the invalid draft visible without reverting on blur", () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "traycer/" });
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "  feat~  ");
    fireEvent.blur(input);

    // Draft is the source of truth while editing - invalid values are not
    // rewritten or reverted to the last saved prefix.
    expect(input.value).toBe("  feat~  ");
    expect(
      screen.getByText("Prefix can't contain ~ ^ : ? * [ or \\."),
    ).toBeTruthy();
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("traycer/");
  });

  it("flushes a pending valid save immediately on blur", () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "feat-");
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );

    fireEvent.blur(input);

    // Flush is synchronous - no timer advance required.
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
    expect(input.value).toBe("feat-");
  });

  it("flushes a pending valid save immediately on Enter via blur wiring", () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "anurag/");
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );

    // Enter → currentTarget.blur() → flush. Assert before any timer advance.
    fireEvent.keyDown(input, { key: "Enter" });

    expect(document.activeElement).not.toBe(input);
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("anurag/");
  });

  it("shows an inline error and does not persist invalid input on blur", () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "traycer/" });
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "bad prefix");
    fireEvent.blur(input);

    expect(screen.getByText("Prefix can't contain spaces.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("bad prefix");
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("traycer/");
  });

  it("grows the card with an additive error row rather than replacing the strip", () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    // Card wrapper is the outermost bordered container around the strip.
    const card = input.closest(".rounded-lg.border");
    expect(card instanceof HTMLElement).toBe(true);
    if (!(card instanceof HTMLElement)) return;
    // Control row (label + input) is present before the error.
    expect(card.querySelector("input")).toBe(input);
    expect(card.textContent).toContain("Default branch prefix");

    typePrefix(input, "bad prefix");

    const error = screen.getByText("Prefix can't contain spaces.");
    expect(card.contains(error)).toBe(true);
    // Error is additive: the control row (input + label) remains inside the same card.
    expect(card.querySelector("input")).toBe(input);
    expect(card.textContent).toContain("Default branch prefix");
    // Error sits as a sibling below the main control row, not replacing it.
    const controlRow = input.closest(".flex.items-center");
    expect(controlRow instanceof HTMLElement).toBe(true);
    if (!(controlRow instanceof HTMLElement)) return;
    expect(controlRow.contains(error)).toBe(false);
    expect(card.contains(controlRow)).toBe(true);
  });

  it("hides the reset button when the saved value is the default", () => {
    render(<WorktreeBranchPrefixSection />);

    expect(
      screen.queryByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    ).toBeNull();
  });

  it("shows the reset button when the saved value differs from the default", () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "feat-" });
    render(<WorktreeBranchPrefixSection />);

    expect(
      screen.getByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    ).toBeTruthy();
  });

  it("shows the reset button for an invalid in-progress draft while saved is still the default", () => {
    // Reset is driven by the ACTIVE DRAFT, not the committed store value, so
    // a pending invalid edit still has a way back to the default.
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    expect(
      screen.queryByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    ).toBeNull();

    typePrefix(input, "-wip/");

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    const reset = screen.getByRole("button", {
      name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
    });
    fireEvent.click(reset);

    expect(input.value).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(
      screen.queryByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores focus to the prefix input after reset unmounts the button", () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "custom/" });
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    fireEvent.click(
      screen.getByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    );

    // Reset button unmounts once the draft is the default - focus must land
    // on the still-mounted input, not drop to <body>.
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("uses a fluid wrap-friendly control row (not a fixed w-44 input)", () => {
    // jsdom does no layout - assert the class contract only.
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    // Control cluster is the Input's direct parent; outer row is one level up.
    const controlCluster = input.parentElement;
    expect(controlCluster instanceof HTMLElement).toBe(true);
    if (!(controlCluster instanceof HTMLElement)) return;
    expect(controlCluster.className).toContain("max-w-full");
    expect(controlCluster.className).toContain("flex-wrap");

    const outerRow = controlCluster.parentElement;
    expect(outerRow instanceof HTMLElement).toBe(true);
    if (!(outerRow instanceof HTMLElement)) return;
    expect(outerRow.className).toContain("flex-wrap");

    expect(input.className).toContain("w-[min(45vw,11rem)]");
    expect(input.className).not.toContain("w-44");
  });

  it("spans the wrapped control row below md and flexes the input into it", () => {
    // jsdom does no layout - assert the class contract only. Below md the
    // cluster has wrapped onto a line of its own, so it takes that line's full
    // width and the input flexes into it instead of keeping its desktop size
    // with dead space beside it.
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    const controlCluster = input.parentElement;
    expect(controlCluster instanceof HTMLElement).toBe(true);
    if (!(controlCluster instanceof HTMLElement)) return;
    expect(controlCluster.className).toContain("max-md:w-full");

    // The desktop width survives in markup - flex-basis is what supersedes it
    // below md, so the two never have to be reconciled by source order.
    expect(input.className).toContain("w-[min(45vw,11rem)]");
    expect(input.className).toContain("max-md:flex-1");
    expect(input.className).toContain("max-md:min-w-0");
  });

  it("keeps visual order aligned with DOM order in the control cluster", () => {
    // Focus order follows the DOM; visual order follows `order-*`. Splitting
    // them puts the keyboard and a screen reader on a control the eye reads
    // somewhere else - here that would announce "Reset" before the field it
    // acts on (WCAG 2.4.3 Focus Order, 1.3.2 Meaningful Sequence). The slot
    // holds a labelled button, so no `order-*` may appear in this cluster at
    // any breakpoint, and the reset slot leads at every width.
    //
    // What that costs is a small leading inset below md, where the slot's
    // reservation sits ahead of the field. That reservation is the point: it
    // is why the input does not jump when the button appears mid-edit, and a
    // steady inset beats a gap opening under the caret.
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    const controlCluster = input.parentElement;
    expect(controlCluster instanceof HTMLElement).toBe(true);
    if (!(controlCluster instanceof HTMLElement)) return;

    for (const child of Array.from(controlCluster.children)) {
      if (!(child instanceof HTMLElement)) continue;
      for (const token of child.className.split(/\s+/).filter(Boolean)) {
        expect(token).not.toMatch(ORDER_UTILITY);
      }
    }

    // The reservation leads, and the field it protects follows it.
    const [resetSlot, field] = Array.from(controlCluster.children);
    expect(resetSlot instanceof HTMLElement).toBe(true);
    expect(field).toBe(input);

    // The guard's own language, pinned - a sweep that never fires is
    // indistinguishable from a sweep that cannot. Every spelling of a reorder
    // must be rejected, INCLUDING the negative one: `-order-1` reverses two
    // controls exactly as `order-last` does, and it is the spelling a pattern
    // anchored on the bare letters silently admits.
    expect("order-last").toMatch(ORDER_UTILITY);
    expect("max-md:order-first").toMatch(ORDER_UTILITY);
    expect("-order-1").toMatch(ORDER_UTILITY);
    expect("max-md:-order-1").toMatch(ORDER_UTILITY);
    // ...while a class that merely contains those letters is left alone.
    expect("border-b").not.toMatch(ORDER_UTILITY);
    expect("max-md:border-t").not.toMatch(ORDER_UTILITY);
  });

  it("truncates the description only from md up, so it wraps below", () => {
    // The single-line clamp is a two-column affordance: beside the input there
    // is one line to spend. Once the control wraps away the sentence owns the
    // width and should use as many lines as it needs. Scoped as `md:truncate`
    // rather than an override of `truncate`, so which rule applies below md is
    // not a question of utility source order.
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    const controlCluster = input.parentElement;
    expect(controlCluster instanceof HTMLElement).toBe(true);
    if (!(controlCluster instanceof HTMLElement)) return;
    const outerRow = controlCluster.parentElement;
    expect(outerRow instanceof HTMLElement).toBe(true);
    if (!(outerRow instanceof HTMLElement)) return;

    const description = outerRow.querySelector("p");
    expect(description instanceof HTMLElement).toBe(true);
    if (!(description instanceof HTMLElement)) return;
    expect(description.className).toContain("md:truncate");
    expect(description.className).not.toMatch(/(^|\s)truncate(\s|$)/);
  });

  it("resets the draft and store to the default immediately on reset click", () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "custom/" });
    render(<WorktreeBranchPrefixSection />);

    fireEvent.click(
      screen.getByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    );

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(getPrefixInput().value).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
    expect(
      screen.queryByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    ).toBeNull();
    // Reset is a user-resolved write - flash the success check.
    expectSavedCheckChrome();
  });

  it("cancels a pending debounce on reset so a stale autosave cannot clobber the default", async () => {
    useSettingsStore.setState({ worktreeBranchPrefix: "custom/" });
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    // Schedules a debounced save of "pending/" while the store is still "custom/".
    typePrefix(input, "pending/");
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("custom/");

    fireEvent.click(
      screen.getByRole("button", {
        name: `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`,
      }),
    );

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(input.value).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 3);
    });

    // Pending "pending/" must never land after the reset.
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(input.value).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
  });

  it("does not clobber the draft when the store updates externally mid-edit", async () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "par");
    expect(input.value).toBe("par");

    // External write (another window / rehydrate) while focused mid-edit.
    act(() => {
      useSettingsStore.setState({ worktreeBranchPrefix: "external/" });
    });

    // Draft must stay on the in-progress typed value - no feedback loop.
    expect(input.value).toBe("par");
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("external/");

    typePrefix(input, "partial/");
    expect(input.value).toBe("partial/");

    await advancePastDebounce();

    expect(input.value).toBe("partial/");
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("partial/");
  });

  it("persists a pending valid autosave on unmount without blur or timer elapse", () => {
    // React does not guarantee blur before unmount (Escape, panel switch).
    // A still-pending valid debounce must flush through the store in cleanup.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const { unmount } = render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "anurag/");
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    // Debounce still pending - spinner shows, no timer advance, no blur.
    expectSavingChrome();

    unmount();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("anurag/");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("adopts an idle external store write into the draft without flashing saved", () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    expect(input.value).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
    expectQuietChrome();

    // External write while idle (no local edit in flight).
    act(() => {
      useSettingsStore.setState({ worktreeBranchPrefix: "external/" });
    });

    expect(input.value).toBe("external/");
    // Idle external adoption must not flash the user-only check indicator.
    expectQuietChrome();
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("external/");

    // Focus + blur with no typing must not write a stale old draft back over
    // the external value (the pre-fix regression).
    input.focus();
    fireEvent.blur(input);

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("external/");
    expect(input.value).toBe("external/");
    expectQuietChrome();
  });

  it("still adopts idle external writes after a whitespace-padded commit", async () => {
    // Regression: inferring "no local edit" from draft === prevSaved broke after
    // any trimmed commit, because raw draft never equaled the trimmed store.
    // hasLocalEdit must clear on commit so a later idle external write is adopted
    // (not stuck on Saving…) and a stray focus+blur cannot clobber it.
    //
    // Flash fix: an adopted external value that differs from the value just
    // flashed must clear the "Saved ✓" indicator immediately - it must not
    // linger over a value it never described.
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "  feat-  ");
    await advancePastDebounce();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
    expect(input.value).toBe("feat-");
    expectSavedCheckChrome();

    act(() => {
      useSettingsStore.setState({ worktreeBranchPrefix: "external/" });
    });

    expect(input.value).toBe("external/");
    // External adopt of a different value clears both spinner and flash.
    expect(
      screen.queryByTestId("worktree-branch-prefix-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("worktree-branch-prefix-saved-check"),
    ).toBeNull();

    input.focus();
    fireEvent.blur(input);

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("external/");
    expect(input.value).toBe("external/");
  });

  it("transitions quiet → spinner → check around a debounced autosave", async () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    expectQuietChrome();

    typePrefix(input, "feat-");

    expectSavingChrome();

    await advancePastDebounce();

    expectSavedCheckChrome();
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");

    // Check auto-hides after SAVED_FLASH_MS.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVED_FLASH_MS);
    });
    expectQuietChrome();
  });

  it("still flashes save feedback for a normalization-only commit (no store write)", async () => {
    // Regression: saving/justSaved used to key off isDirty (draft.trim() !==
    // saved). A pure whitespace edit that trims to the already-saved value
    // never wrote the store and never showed spinner/check. hasLocalEdit now
    // drives both indicators so any resolved local edit flashes the check.
    useSettingsStore.setState({ worktreeBranchPrefix: "feat-" });
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    expect(input.value).toBe("feat-");
    expectQuietChrome();

    typePrefix(input, "  feat-  ");
    expectSavingChrome();
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");

    await advancePastDebounce();

    // Store value is unchanged - no actual write - but the check still flashes.
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
    expect(input.value).toBe("feat-");
    expectSavedCheckChrome();
  });

  it("announces save state via an accessible live-status region", async () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(status.textContent).toBe("");

    typePrefix(input, "feat-");
    expect(screen.getByRole("status").textContent).toBe("Saving…");

    await advancePastDebounce();
    expect(screen.getByRole("status").textContent).toBe("Saved");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVED_FLASH_MS);
    });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows the validation error instead of spinner/check for invalid dirty drafts", () => {
    render(<WorktreeBranchPrefixSection />);
    const input = getPrefixInput();

    typePrefix(input, "bad prefix");

    // Dirty relative to saved, but error takes priority over the saving slot.
    expect(screen.getByText("Prefix can't contain spaces.")).toBeTruthy();
    expectQuietChrome();
  });
});
