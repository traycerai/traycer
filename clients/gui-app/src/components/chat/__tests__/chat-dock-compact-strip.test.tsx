import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStatusAnimationClockForTests } from "@/lib/animation/status-animation-clock";
import {
  ChatDockCompactStrip,
  ChatDockCompactStripProvider,
  type ChatDockCompactChipGlyph,
  type ChatDockCompactChipModel,
  type ChatDockCompactStripValue,
  type ChatDockSection,
} from "@/components/chat/chat-dock-compact-strip";
import { TooltipProvider } from "@/components/ui/tooltip";

function chip(
  section: ChatDockSection,
  text: string,
): ChatDockCompactChipModel {
  return {
    section,
    glyph: section === "background" ? "mixed" : section,
    workingWord: null,
    text,
    lineDeltas: null,
    label: `${section} label`,
    pulseToken: null,
  };
}

function chipWithGlyph(
  section: ChatDockSection,
  glyph: ChatDockCompactChipGlyph,
): ChatDockCompactChipModel {
  return { ...chip(section, "1"), glyph };
}

/** The chip's printed short form, with the trailing activity word dropped. */
function chipText(chipElement: HTMLElement): string {
  const clone = chipElement.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error("cloning the chip did not produce an element");
  }
  clone.querySelector("[data-chip-working-word]")?.remove();
  return clone.textContent;
}

/** The lucide class naming the icon a chip drew, or null if it drew none. */
function drawnIcon(chipElement: HTMLElement): string | null {
  const svg = chipElement.querySelector("svg");
  if (svg === null) return null;
  const match = /\blucide-([a-z0-9-]+)/.exec(svg.getAttribute("class") ?? "");
  return match?.[1] ?? null;
}

function iconClasses(chipElement: HTMLElement): string {
  return chipElement.querySelector("svg")?.getAttribute("class") ?? "";
}

/** The ping ring behind a working chip's corner dot, or null at rest. */
function activityRing(section: string): HTMLElement | null {
  const ring = screen
    .getByTestId(`chat-dock-chip-${section}`)
    .querySelector(".status-ping");
  return ring instanceof HTMLElement ? ring : null;
}

/** The ring's current scale factor, or NaN when it is not drawing one. */
function ringScale(section: string): number {
  const transform = activityRing(section)?.style.transform ?? "";
  return Number(/scale\(([0-9.]+)\)/.exec(transform)?.[1] ?? Number.NaN);
}

function workingWord(section: string): string | null {
  return (
    screen
      .getByTestId(`chat-dock-chip-${section}`)
      .querySelector("[data-chip-working-word]")?.textContent ?? null
  );
}

function renderStrip(value: ChatDockCompactStripValue) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatDockCompactStripProvider value={value}>
        <ChatDockCompactStrip />
      </ChatDockCompactStripProvider>
    </TooltipProvider>,
  );
}

describe("<ChatDockCompactStrip />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing outside a provider", () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <ChatDockCompactStrip />
      </TooltipProvider>,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing with an empty chip list", () => {
    const { container } = renderStrip({
      chips: [],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    expect(container.firstChild).toBeNull();
  });

  it("renders one chip per model, in order", () => {
    renderStrip({
      chips: [
        chip("filesChanged", "+1 −2"),
        chip("activeAgents", "3"),
        chip("background", "1"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const strip = screen.getByTestId("chat-dock-compact-strip");
    const filesChanged = screen.getByTestId("chat-dock-chip-filesChanged");
    const activeAgents = screen.getByTestId("chat-dock-chip-activeAgents");
    const background = screen.getByTestId("chat-dock-chip-background");

    expect(strip.contains(filesChanged)).toBe(true);
    expect(strip.contains(activeAgents)).toBe(true);
    expect(strip.contains(background)).toBe(true);
    expect(
      filesChanged.compareDocumentPosition(activeAgents) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      activeAgents.compareDocumentPosition(background) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws each section's own icon at rest", () => {
    renderStrip({
      chips: [
        chip("filesChanged", "+1 −2"),
        chip("activeAgents", "3"),
        chipWithGlyph("background", "mixed"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    expect(drawnIcon(screen.getByTestId("chat-dock-chip-filesChanged"))).toBe(
      "file-diff",
    );
    expect(drawnIcon(screen.getByTestId("chat-dock-chip-activeAgents"))).toBe(
      "bot",
    );
    expect(drawnIcon(screen.getByTestId("chat-dock-chip-background"))).toBe(
      "layers",
    );
    // A resting chip is the bare icon: no activity wrapper, no ring, no word,
    // and a number that keeps the chip's own muted tone.
    for (const section of ["filesChanged", "activeAgents", "background"]) {
      const chipElement = screen.getByTestId(`chat-dock-chip-${section}`);
      expect(chipElement.querySelector("[data-chip-activity]")).toBeNull();
      expect(activityRing(section)).toBeNull();
      expect(workingWord(section)).toBeNull();
      expect(iconClasses(chipElement)).not.toContain("text-primary");
    }
  });

  // The whole of this: a working chip keeps SAYING what it is. The icon is the
  // only thing that does, so activity lights it rather than taking its place -
  // and it lights in three channels at once, because one blink was not enough
  // to tell a live PR watcher from a stopped one.
  it("lights the section's own icon while a chip is working, and keeps its number", () => {
    renderStrip({
      chips: [
        {
          ...chipWithGlyph("activeAgents", "activeAgents"),
          text: "2",
          workingWord: "working",
        },
        chipWithGlyph("background", "wakeup"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const agents = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(drawnIcon(agents)).toBe("bot");
    // Displaces the chip's muted inherit, so the glyph itself reads as live.
    expect(iconClasses(agents)).toContain("text-primary");
    const wrapper = agents.querySelector("[data-chip-activity]");
    expect(wrapper).not.toBeNull();
    // The corner mark below is absolutely positioned against this wrapper.
    expect(wrapper?.getAttribute("class")).toContain("relative");
    expect(activityRing("activeAgents")).not.toBeNull();
    expect(workingWord("activeAgents")).toBe("working");
    expect(chipText(agents)).toBe("2");

    const background = screen.getByTestId("chat-dock-chip-background");
    expect(drawnIcon(background)).toBe("alarm-clock");
    expect(iconClasses(background)).not.toContain("text-primary");
    expect(background.querySelector("[data-chip-activity]")).toBeNull();
  });

  // The dot is the ring's anchor AND the reduced-motion statement in one: it
  // is drawn unconditionally while working, so the chip needs no media query
  // to stay legible when the ring cannot move. (The ring collapses to a static
  // span exactly the dot's size, behind the dot - `useStatusAnimation` never
  // subscribes under the preference.)
  it("marks a working chip's corner whether or not the ring can move", () => {
    renderStrip({
      chips: [
        {
          ...chipWithGlyph("activeAgents", "activeAgents"),
          workingWord: "working",
        },
        chipWithGlyph("background", "wakeup"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const dot = screen
      .getByTestId("chat-dock-chip-activeAgents")
      .querySelector("[data-chip-activity-dot]");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("class")).not.toContain("hidden");
    expect(dot?.getAttribute("class")).not.toContain("motion-reduce:");
    expect(
      screen
        .getByTestId("chat-dock-chip-background")
        .querySelector("[data-chip-activity-dot]"),
    ).toBeNull();
  });

  // No braille anywhere in the strip: the spinner is what made `⋮ 2  ⋮ 1`.
  // And no CSS animation either - an always-on `animation:` is the renderer
  // regression `status-animation-clock.ts` exists to keep out of the tree.
  it("renders no spinner node and no CSS animation in any state", () => {
    renderStrip({
      chips: [
        {
          ...chipWithGlyph("activeAgents", "activeAgents"),
          workingWord: "working",
        },
        { ...chipWithGlyph("background", "monitor"), workingWord: "running" },
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const strip = screen.getByTestId("chat-dock-compact-strip");
    expect(strip.querySelector(".working-dots")).toBeNull();
    expect(strip.textContent).toBe("1working1running");
    for (const element of strip.querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(
        /(^|[\s:])animate-/,
      );
    }
  });

  // The ring is driven from the app's one status clock, not from CSS: it is
  // the shared `PingRing`, so every live indicator in the window rides the
  // same tick. Driven here exactly as the spinner's own suite drives it.
  describe("clock-driven ring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetStatusAnimationClockForTests();
    });

    afterEach(() => {
      cleanup();
      resetStatusAnimationClockForTests();
      vi.useRealTimers();
    });

    it("expands and fades the working chip's ring across the cycle", () => {
      renderStrip({
        chips: [
          {
            ...chipWithGlyph("activeAgents", "activeAgents"),
            workingWord: "working",
          },
          chipWithGlyph("background", "wakeup"),
        ],
        expanded: new Set(),
        onToggle: vi.fn(),
      });

      // Written pre-paint, so the first frame is already in place.
      const ring = activityRing("activeAgents");
      expect(ring?.style.transform).toBe("scale(1.000)");
      expect(ring?.style.opacity).toBe("0.75");

      // The ring finishes growing three quarters through the second, at which
      // point it is twice the dot and fully faded.
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(ring?.style.transform).toBe("scale(2.000)");
      expect(ring?.style.opacity).toBe("0");

      // Past the second it starts over, small and bright. The clock ticks
      // every 80 ms, so the first frame of the new cycle lands at 1040 rather
      // than on the second itself.
      act(() => {
        vi.advanceTimersByTime(240);
      });
      expect(ringScale("activeAgents")).toBeLessThan(1.2);
      expect(Number(ring?.style.opacity)).toBeGreaterThan(0.6);

      // A resting chip has no ring to write to, however long the clock runs.
      expect(activityRing("background")).toBeNull();
      // ...and the icon itself never moves: one motion per chip, not two.
      expect(
        screen.getByTestId("chat-dock-chip-activeAgents").querySelector("svg")
          ?.style.opacity,
      ).toBe("");
    });
  });

  // The Background chip borrows the panel's own per-kind glyphs, so a chip
  // over one kind of row is recognisable as that kind without opening it.
  it.each([
    ["subagent", "bot"],
    ["command", "square-terminal"],
    ["monitor", "monitor"],
    ["wakeup", "alarm-clock"],
    ["workflow", "workflow"],
    ["mcp", "plug"],
    // A managed shell is a terminal running or held. Never `circle-pause`:
    // that glyph reads as "paused" with no row beside it saying otherwise, and
    // a shell following a PR is the case that proved it.
    ["managedShell", "terminal"],
  ] as const)(
    "draws the %s kind's icon on a resting background chip",
    (kind, icon) => {
      renderStrip({
        chips: [chipWithGlyph("background", kind)],
        expanded: new Set(),
        onToggle: vi.fn(),
      });

      expect(drawnIcon(screen.getByTestId("chat-dock-chip-background"))).toBe(
        icon,
      );
    },
  );

  // The state axis and the glyph axis are independent: a shell draws one
  // terminal either way, and it is the ring, the tone and the word that say
  // which. A regression that reintroduced a state-dependent glyph would have
  // to break this and the row above it together.
  it("keeps the terminal glyph on a running managed shell", () => {
    renderStrip({
      chips: [
        {
          ...chipWithGlyph("background", "managedShell"),
          workingWord: "running",
        },
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const chipElement = screen.getByTestId("chat-dock-chip-background");
    expect(drawnIcon(chipElement)).toBe("terminal");
    expect(chipElement.querySelector("svg.lucide-circle-pause")).toBeNull();
    expect(activityRing("background")).not.toBeNull();
    expect(workingWord("background")).toBe("running");
  });

  // The model carries the deltas; the strip only has to hand them on, and
  // must not invent them for a chip that has none.
  it("passes a chip's line deltas through to the chip it renders", () => {
    renderStrip({
      chips: [
        {
          ...chip("filesChanged", "3"),
          lineDeltas: { additions: 12, deletions: 4 },
        },
        chip("activeAgents", "2"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    expect(screen.getByTestId("chat-dock-chip-filesChanged").textContent).toBe(
      "3+12−4",
    );
    expect(screen.getByTestId("chat-dock-chip-activeAgents").textContent).toBe(
      "2",
    );
  });

  it("calls onToggle with the clicked chip's section", () => {
    const onToggle = vi.fn();
    renderStrip({
      chips: [chip("background", "2")],
      expanded: new Set(),
      onToggle,
    });

    fireEvent.click(screen.getByTestId("chat-dock-chip-background"));

    expect(onToggle).toHaveBeenCalledWith("background");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
