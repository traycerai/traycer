import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  ChatDockChipArrival,
  ChatDockCompactChip,
  type ChatDockChipTooltipLines,
} from "@/components/chat/chat-dock-compact-chip";
import { ToolbarIconButton } from "@/components/home/toolbar/toolbar-buttons";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

interface ChipProps {
  readonly icon: ReactElement;
  readonly text: string;
  readonly working: boolean;
  readonly lineDeltas: DiffLineCounts | null;
  readonly label: string;
  readonly tooltipLines: ChatDockChipTooltipLines | null;
  readonly pulseToken: string | null;
  readonly expanded: boolean;
  readonly controls: string | null;
  readonly testId: string;
  readonly onClick: () => void;
}

function baseProps(): ChipProps {
  return {
    icon: <span data-testid="chip-icon" />,
    text: "3",
    working: false,
    lineDeltas: null,
    label: "3 agents running. Show the active agents.",
    // `null` by default, which is the layout editor's picture: the tooltip
    // tests below pass lines where they mean to.
    tooltipLines: null,
    pulseToken: null,
    expanded: false,
    controls: null,
    testId: "chip",
    onClick: vi.fn(),
  };
}

function classesOf(element: Element): ReadonlyArray<string> {
  return element.getAttribute("class")?.split(/\s+/).filter(Boolean) ?? [];
}

/**
 * The chip's number and its two delta groups, read off their own markers
 * rather than by their text.
 *
 * `getByText` is no longer able to find them: each of the three is now a
 * static sign or a tone beside a `<RollingNumber>`, and Testing Library's text
 * matcher joins only an element's DIRECT text nodes - so the span wearing the
 * tone reads as `+` and the span carrying the digits wears no tone at all.
 * `textContent` is unchanged, which is what these read.
 */
function part(chip: HTMLElement, marker: string): Element {
  const found = chip.querySelector(`[${marker}]`);
  if (found === null) throw new Error(`chip has no ${marker}`);
  return found;
}

function renderChip(props: ChipProps) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatDockCompactChip {...props} />
    </TooltipProvider>,
  );
}

function rerenderChip(
  rerender: (ui: ReactElement) => void,
  props: ChipProps,
): void {
  rerender(
    <TooltipProvider delayDuration={0}>
      <ChatDockCompactChip {...props} />
    </TooltipProvider>,
  );
}

// jsdom has no global `AnimationEvent`, so React's vendor-prefix probe
// (`getVendorPrefixedEventName`) drops its unprefixed "animationend" fallback
// and lands on the `WebkitAnimation` entry jsdom's `CSSStyleDeclaration` does
// expose - React ends up listening for `webkitAnimationEnd`, never plain
// `animationend`. `fireEvent.animationEnd` dispatches the standard name and is
// silently swallowed here, so the real event name is dispatched directly.
function fireAnimationEnd(element: Element): void {
  fireEvent(
    element,
    new Event("webkitAnimationEnd", { bubbles: true, cancelable: true }),
  );
}

describe("<ChatDockCompactChip />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the icon and the short text", () => {
    renderChip(baseProps());

    expect(screen.getByTestId("chip-icon")).not.toBeNull();
    expect(screen.getByText("3")).not.toBeNull();
  });

  // The Files changed chip prints two measurements: the count, then the lines,
  // in the panel's own tones. `null` is every other chip, which counts one
  // thing and must gain no second span for it.
  // The tones are `DiffLineDeltas`' own (`diff-line-deltas.test.tsx`); what is
  // this chip's is where the pair sits.
  it("prints the line deltas after the short form", () => {
    renderChip({
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 12, deletions: 4 },
    });

    const chip = screen.getByTestId("chip");
    expect(chip.textContent).toBe("3+12−4");
    const additions = part(chip, "data-diff-additions");
    const deletions = part(chip, "data-diff-deletions");
    expect(additions.textContent).toBe("+12");
    expect(deletions.textContent).toBe("−4");
  });

  it("omits a zero side, and the whole delta group for a chip with none", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 12, deletions: 0 },
    });
    const chip = screen.getByTestId("chip");
    expect(chip.textContent).toBe("3+12");

    rerenderChip(rerender, {
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 0, deletions: 4 },
    });
    expect(chip.textContent).toBe("3−4");

    // Both zero draws NO span, not an empty one: a chip is a few characters
    // wide, so an empty counts group is a visible gap after the number.
    rerenderChip(rerender, {
      ...baseProps(),
      text: "3",
      lineDeltas: { additions: 0, deletions: 0 },
    });
    expect(chip.textContent).toBe("3");
    expect(chip.childElementCount).toBe(2);

    rerenderChip(rerender, { ...baseProps(), text: "3", lineDeltas: null });
    expect(chip.textContent).toBe("3");
    expect(chip.childElementCount).toBe(2);
  });

  // The number is the chip's loudest text, so it carries the state too - as a
  // tone, which costs no width. The chip's only other text is the deltas.
  it("tones the number while working", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      text: "1",
      working: true,
    });

    const chip = screen.getByTestId("chip");
    // The tone is on the span that OWNS the number, never on the rolling
    // number itself - it carries no colour, and inherits this one across the
    // shadow boundary it draws its digits inside.
    expect(part(chip, "data-chip-count").getAttribute("class")).toContain(
      "text-primary",
    );
    expect(chip.textContent).toBe("1");

    rerenderChip(rerender, { ...baseProps(), text: "1", working: false });

    expect(part(chip, "data-chip-count").getAttribute("class")).not.toContain(
      "text-primary",
    );
  });

  // The word that used to follow the number (`1 running`) is gone: a chip is
  // `[icon] N` at every width, so nothing here may be width-conditional and
  // there is no container query left to fold. The state is the icon's job, and
  // `label`'s.
  it("prints no working word, and no width-gated node, at any width", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      text: "1",
      working: true,
      label: "Background. 1 running.",
    });

    const chip = screen.getByTestId("chip");
    expect(chip.querySelector("[data-chip-working-word]")).toBeNull();
    expect(chip.textContent).toBe("1");
    expect(chip.childElementCount).toBe(2);
    for (const element of [chip, ...chip.querySelectorAll("*")]) {
      expect(element.getAttribute("class") ?? "").not.toMatch(/@(min|max)-/);
    }
    // The sentence is unchanged - it is the one channel that still says it.
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 running.");

    // ...and an idle chip is the same shape, one tone lighter.
    rerenderChip(rerender, { ...baseProps(), text: "1", working: false });
    expect(chip.querySelector("[data-chip-working-word]")).toBeNull();
    expect(chip.textContent).toBe("1");
    expect(chip.childElementCount).toBe(2);
  });

  it("uses the whole sentence as the accessible name", () => {
    renderChip(baseProps());

    expect(
      screen.getByRole("button", {
        name: "3 agents running. Show the active agents.",
      }),
    ).not.toBeNull();
  });

  it("tracks aria-pressed with expanded", () => {
    const props = { ...baseProps(), expanded: false };
    const { rerender } = renderChip(props);

    expect(screen.getByTestId("chip").getAttribute("aria-pressed")).toBe(
      "false",
    );

    rerenderChip(rerender, { ...props, expanded: true });

    expect(screen.getByTestId("chip").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  // A13 / L-97: the artifact's `.dchip` is a small BORDERED pill with the
  // count in the foreground, and it borrows the composer toolbar's chip
  // vocabulary (`toolbar-buttons.tsx`, restyled in the same pass) so the two
  // rows of chips around the input read as one system.
  //
  // Read OFF the toolbar chip rather than restated, the way
  // `toolbar-buttons.test.tsx` reads the pill off the square: a list of class
  // literals copied from `chat-dock-compact-chip.tsx` observes nothing that
  // file does not already say, and can only fail for a rename. This fails for
  // the thing that actually goes wrong - a state added to the toolbar chip and
  // forgotten on the dock chip, or the other way round.
  it("borrows the toolbar chip's material and states", () => {
    // The dock chip has no Toolbar-style setting of its own and is always
    // bordered (its pressed state reads against the border, not a fill
    // alone), so it is read off the toolbar chip's BORDERED style - the one
    // whose material vocabulary it actually borrows - not whichever style
    // Layout ▸ Composer ▸ Toolbar currently has picked.
    useLayoutStore.getState().setRegionValues("model", {
      toolbarStyle: "bordered",
    });
    render(<ToolbarIconButton aria-label="probe" />);
    const square = classesOf(screen.getByRole("button", { name: "probe" }));
    cleanup();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });

    renderChip(baseProps());
    const chip = classesOf(screen.getByTestId("chip"));

    // The material: one bordered box on the app's own background.
    for (const material of ["border", "border-border", "bg-background"]) {
      expect(square, `toolbar chip lost ${material}`).toContain(material);
      expect(chip, `dock chip lost ${material}`).toContain(material);
    }
    // The states, minus the two families a dock chip has no state for: it
    // opens no menu (`data-[state=open]:`) and is never disabled, being the
    // only door back to the row it folded away (`disabled:`).
    const states = square.filter(
      (candidate) =>
        candidate.includes(":") &&
        !candidate.startsWith("data-[state=open]:") &&
        !candidate.startsWith("disabled:"),
    );
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(chip, `dock chip is missing ${state}`).toContain(state);
    }
  });

  // The one geometry claim that is genuinely this component's: a chip counts a
  // thing rather than opening a menu, so it is the round one.
  it("is a pill, and puts the count in the foreground", () => {
    renderChip(baseProps());

    const chip = screen.getByTestId("chip");
    expect(classesOf(chip)).toContain("rounded-full");
    expect(classesOf(chip)).not.toContain("rounded-md");

    const count = chip.querySelector(".tabular-nums");
    expect(count?.className).toContain("text-foreground");
  });

  // On a borderless chip a fill alone carried the toggle. On a bordered pill
  // it reads as a hover that stuck, so the border moves too.
  it("marks the expanded state on the border as well as the fill", () => {
    const props = { ...baseProps(), expanded: false };
    const { rerender } = renderChip(props);

    expect(screen.getByTestId("chip").className).not.toContain(
      "border-foreground/25",
    );

    rerenderChip(rerender, { ...props, expanded: true });

    const chip = screen.getByTestId("chip");
    expect(chip.className).toContain("border-foreground/25");
    expect(chip.className).toContain("bg-accent");
    expect(chip.className).toContain("text-foreground");
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    renderChip({ ...baseProps(), onClick });

    fireEvent.click(screen.getByTestId("chip"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // A chip exists only while its section has something to show, so mounting
  // WITH a non-null token is the case that matters most: "the first agent
  // started" and "this chip mounted" are the same instant, and that first
  // arrival must not be the one pulse the chip swallows.
  it("pulses on mount when pulseToken is already non-null", () => {
    renderChip({ ...baseProps(), pulseToken: "3" });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe("true");
  });

  it("does not pulse on mount when pulseToken is null", () => {
    renderChip({ ...baseProps(), pulseToken: null });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();
  });

  it("clears the pulse on animationend", () => {
    renderChip({ ...baseProps(), pulseToken: "3" });
    const chip = screen.getByTestId("chip");
    expect(chip.getAttribute("data-pulse")).toBe("true");

    fireAnimationEnd(chip);

    expect(chip.getAttribute("data-pulse")).toBeNull();
  });

  it("pulses again when pulseToken changes to a different non-null value", () => {
    const props = { ...baseProps(), pulseToken: "3" };
    const { rerender } = renderChip(props);
    fireAnimationEnd(screen.getByTestId("chip"));
    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();

    rerenderChip(rerender, { ...props, pulseToken: "5" });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe("true");
  });

  it("does not pulse when pulseToken changes to null", () => {
    const props = { ...baseProps(), pulseToken: "3" };
    const { rerender } = renderChip(props);

    rerenderChip(rerender, { ...props, pulseToken: null });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();
  });

  // A failure is the one arrival on this strip that is not simply news, so it
  // rings in the destructive tone. The flavour rides the TOKEN rather than a
  // second prop: the ring fires on the token changing, so a flavour that could
  // move without it would be a ring that never ran.
  it("rings a failure token in the destructive tone", () => {
    const { rerender } = renderChip({
      ...baseProps(),
      pulseToken: "failed:cmd-1",
    });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe(
      "failure",
    );

    // A second failure is a second token, so it rings again - and a shell
    // merely running goes back to the plain ring.
    fireAnimationEnd(screen.getByTestId("chip"));
    rerenderChip(rerender, { ...baseProps(), pulseToken: "failed:cmd-2" });
    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe(
      "failure",
    );

    fireAnimationEnd(screen.getByTestId("chip"));
    rerenderChip(rerender, { ...baseProps(), pulseToken: "running" });
    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe("true");
  });

  it("does not pulse again on a re-render with the same token once cleared", () => {
    const props = { ...baseProps(), pulseToken: "3" };
    const { rerender } = renderChip(props);
    fireAnimationEnd(screen.getByTestId("chip"));
    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();

    rerenderChip(rerender, { ...props, pulseToken: "3" });

    expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBeNull();
  });

  // The strip's half of the first-paint rule. A chip mounted inside a
  // suppressed arrival swallows its mount pulse for good - pinned through the
  // strip in `chat-dock-compact-strip.test.tsx` ("first paint") - but the
  // token still moving IS news, whenever the chip mounted.
  describe("under a suppressed arrival", () => {
    it("still pulses when the token changes afterwards", () => {
      const props = { ...baseProps(), pulseToken: "3" };
      const { rerender } = render(
        <TooltipProvider delayDuration={0}>
          <ChatDockChipArrival suppressed>
            <ChatDockCompactChip {...props} />
          </ChatDockChipArrival>
        </TooltipProvider>,
      );

      rerender(
        <TooltipProvider delayDuration={0}>
          <ChatDockChipArrival suppressed={false}>
            <ChatDockCompactChip {...props} pulseToken="4" />
          </ChatDockChipArrival>
        </TooltipProvider>,
      );

      expect(screen.getByTestId("chip").getAttribute("data-pulse")).toBe(
        "true",
      );
    });
  });

  // The roll is per NUMBER, and only where the whole short form is numbers
  // with known furniture between them. `+1 −2` and `99+` are printed as they
  // stand: parsing them would roll pieces the caller never meant to expose.
  describe("rolling counts", () => {
    it("keeps every short form's text exactly as it reads", () => {
      // The four-figure shapes are the ones that pin it: the rolling branch
      // formats through `Intl.NumberFormat`, which would otherwise print
      // `1,234` where the panel this pill stands in for prints `1234`.
      const shapes = [
        "3",
        "0",
        "2 · 1",
        "2/5",
        "99+",
        "+1 −2",
        "1234",
        "1234/5678",
      ];
      for (const text of shapes) {
        renderChip({ ...baseProps(), text });
        expect(screen.getByTestId("chip").textContent, text).toBe(text);
        cleanup();
      }
    });
  });
});

/**
 * L-153: a pill's tooltip is a compact hierarchy rather than the run-on
 * accessible sentence it used to repeat. The dock's own suite pins WHAT each
 * kind says; this pins how the three lines are drawn, and what a chip with no
 * lines at all falls back to.
 */
describe("the pill's tooltip", () => {
  afterEach(() => {
    cleanup();
  });

  async function openTooltip(): Promise<HTMLElement> {
    fireEvent.focus(screen.getByTestId("chip"));
    return screen.findByRole("tooltip");
  }

  it("stacks the name, the counts and the affordance, in that order", async () => {
    renderChip({
      ...baseProps(),
      tooltipLines: { name: "Files changed", detail: "3 files, +47 −9" },
    });

    const tooltip = await openTooltip();
    expect(tooltip.textContent).toBe(
      "Files changed3 files, +47 −9Click to open",
    );
    // One block, not three siblings of the tooltip's own row: `TooltipContent`
    // is `inline-flex items-center`, so three children become three columns
    // and each wraps into a ribbon.
    const block = tooltip.firstElementChild;
    const blockClasses = classesOf(block as Element);
    expect(blockClasses).toContain("flex-col");
    // Falling weight down the block: the name leads, the counts are quieter,
    // the affordance is quietest.
    const lines = [...(block?.children ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual([
      "Files changed",
      "3 files, +47 −9",
      "Click to open",
    ]);
    expect(classesOf(lines[0])).toContain("font-medium");
    expect(classesOf(lines[1])).toContain("text-background/70");
    expect(classesOf(lines[2])).toContain("text-background/55");
  });

  it("leaves the accessible name a sentence, not the block", async () => {
    renderChip({
      ...baseProps(),
      label: "Files changed. 3 files, 47 lines added, 9 removed.",
      tooltipLines: { name: "Files changed", detail: "3 files" },
    });

    await openTooltip();
    // The two are worded for different readers and must not collapse into
    // one: a screen reader cannot hear a `+`, a tone or a click affordance.
    expect(screen.getByTestId("chip").getAttribute("aria-label")).toBe(
      "Files changed. 3 files, 47 lines added, 9 removed.",
    );
  });

  it("falls back to that sentence when it is handed no lines", async () => {
    // The layout editor draws these chips as PICTURES in its form, with no
    // counts and an `onClick` that does nothing - so "Click to open" under
    // one would be a lie. `tooltipLines={null}` is what those five sites pass.
    renderChip({ ...baseProps(), label: "Active agents", tooltipLines: null });

    expect((await openTooltip()).textContent).toBe("Active agents");
  });
});
