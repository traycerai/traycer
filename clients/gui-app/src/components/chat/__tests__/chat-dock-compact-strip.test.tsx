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
    working: false,
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

/**
 * The corner mark a working chip used to draw - a filled dot with the app's
 * ping ring behind it, and the wrapper both hung off. Nothing draws one in any
 * state now, so this looks for every part at once: putting the dot back
 * without its ring, or the positioning wrapper on its own, has to fail too.
 */
function cornerMark(section: string): Element | null {
  return screen
    .getByTestId(`chat-dock-chip-${section}`)
    .querySelector(
      "[data-chip-activity-dot], [data-chip-activity], .status-ping",
    );
}

/** The shimmering glyph of a working chip, or null when it draws a resting one. */
function shimmerGlyph(section: string): HTMLElement | SVGElement | null {
  const glyph = screen
    .getByTestId(`chat-dock-chip-${section}`)
    .querySelector("[data-chip-glyph-shimmer]");
  return glyph instanceof HTMLElement || glyph instanceof SVGElement
    ? glyph
    : null;
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
    // A resting chip is the bare icon: no corner mark, no shimmer, and a
    // number that keeps the chip's own muted tone.
    for (const section of ["filesChanged", "activeAgents", "background"]) {
      const chipElement = screen.getByTestId(`chat-dock-chip-${section}`);
      expect(cornerMark(section)).toBeNull();
      expect(shimmerGlyph(section)).toBeNull();
      expect(iconClasses(chipElement)).not.toContain("text-primary");
    }
  });

  // The whole of this: a working chip keeps SAYING what it is. The icon is the
  // only thing that does - and, with the word gone, the only thing saying it is
  // busy too, so it lights in both the channels it has: tone and shimmer.
  it("lights the section's own icon while a chip is working, and keeps its number", () => {
    renderStrip({
      chips: [
        {
          ...chipWithGlyph("activeAgents", "activeAgents"),
          text: "2",
          working: true,
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
    // The shimmer rides the glyph itself, and the glyph is the whole of what
    // the working chip draws - no wrapper, nothing at its corner.
    expect(shimmerGlyph("activeAgents")).toBe(agents.querySelector("svg"));
    expect(cornerMark("activeAgents")).toBeNull();
    expect(agents.textContent).toBe("2");

    const background = screen.getByTestId("chat-dock-chip-background");
    expect(drawnIcon(background)).toBe("alarm-clock");
    expect(iconClasses(background)).not.toContain("text-primary");
    expect(shimmerGlyph("background")).toBeNull();
  });

  // Agents and background are one vocabulary and now one SHAPE: whatever a
  // running chip draws, the other draws too. The word they used to print was
  // the last thing that could differ between them, and it printed a different
  // word on each.
  it("gives a working agents chip and a working background chip the same shape", () => {
    renderStrip({
      chips: [
        { ...chipWithGlyph("activeAgents", "activeAgents"), working: true },
        { ...chipWithGlyph("background", "monitor"), working: true },
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    for (const section of ["activeAgents", "background"]) {
      const chipElement = screen.getByTestId(`chat-dock-chip-${section}`);
      expect(chipElement.textContent).toBe("1");
      expect(shimmerGlyph(section)).not.toBeNull();
      expect(cornerMark(section)).toBeNull();
      expect(iconClasses(chipElement)).toContain("text-primary");
    }
    // Different sections, so different glyphs - that is the ONE axis on which
    // two running chips are allowed to differ.
    expect(drawnIcon(screen.getByTestId("chat-dock-chip-activeAgents"))).toBe(
      "bot",
    );
    expect(drawnIcon(screen.getByTestId("chat-dock-chip-background"))).toBe(
      "monitor",
    );
  });

  // Nothing is drawn over the glyph, in either state. The corner dot that used
  // to sit there was the size of a third of the icon it overlapped, so a
  // running terminal read as a terminal with something stuck to it - and the
  // tone and the shimmer were already saying what the dot was there to say.
  it("draws nothing at a chip's corner, working or at rest", () => {
    renderStrip({
      chips: [
        { ...chipWithGlyph("activeAgents", "activeAgents"), working: true },
        chipWithGlyph("background", "wakeup"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    expect(cornerMark("activeAgents")).toBeNull();
    expect(cornerMark("background")).toBeNull();
    // A working chip draws ONE element of its own: the glyph.
    const agents = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(agents.querySelectorAll("svg")).toHaveLength(1);
    expect(shimmerGlyph("activeAgents")).toBe(agents.querySelector("svg"));
  });

  // No braille anywhere in the strip: the spinner is what made `⋮ 2  ⋮ 1`.
  // And no CSS animation either - an always-on `animation:` is the renderer
  // regression `status-animation-clock.ts` exists to keep out of the tree.
  it("renders no spinner node and no CSS animation in any state", () => {
    renderStrip({
      chips: [
        { ...chipWithGlyph("activeAgents", "activeAgents"), working: true },
        { ...chipWithGlyph("background", "monitor"), working: true },
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const strip = screen.getByTestId("chat-dock-compact-strip");
    expect(strip.querySelector(".working-dots")).toBeNull();
    // Two running chips, and the whole of what they print is their counts.
    expect(strip.textContent).toBe("11");
    for (const element of strip.querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(
        /(^|[\s:])animate-/,
      );
      expect(element.getAttribute("style") ?? "").not.toContain("animation");
    }
  });

  // The glyph's shimmer is driven from the app's one status clock, not from
  // CSS: an inline `opacity` written by the shared hook, so every live
  // indicator in the window rides the same tick. Driven here exactly as the
  // spinner's own suite drives it.
  describe("clock-driven shimmer", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetStatusAnimationClockForTests();
    });

    afterEach(() => {
      cleanup();
      resetStatusAnimationClockForTests();
      vi.useRealTimers();
    });

    // The whole of the running treatment's motion, now that the corner is
    // bare: one opacity sweep on the icon, a second per cycle. A resting chip
    // is never written to at all.
    it("sweeps the working glyph's opacity across the cycle", () => {
      renderStrip({
        chips: [
          { ...chipWithGlyph("activeAgents", "activeAgents"), working: true },
          chipWithGlyph("background", "wakeup"),
        ],
        expanded: new Set(),
        onToggle: vi.fn(),
      });

      // Written pre-paint, at full strength: the top of the cycle.
      const glyph = shimmerGlyph("activeAgents");
      expect(Number(glyph?.style.opacity)).toBeCloseTo(1, 2);

      // Dimmest at the midpoint...
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(Number(glyph?.style.opacity)).toBeCloseTo(0.35, 2);

      // ...and back up as the second closes. The clock ticks every 80 ms, so
      // the first frame of the new cycle lands at 1040 rather than on the
      // second itself.
      act(() => {
        vi.advanceTimersByTime(540);
      });
      expect(Number(glyph?.style.opacity)).toBeGreaterThan(0.95);

      // The glyph never blinks out - it is the only thing saying WHICH section
      // the chip stands for, at every point of the sweep.
      for (let elapsed = 0; elapsed < 1000; elapsed += 80) {
        act(() => {
          vi.advanceTimersByTime(80);
        });
        expect(Number(glyph?.style.opacity)).toBeGreaterThanOrEqual(0.35);
      }

      // A resting chip draws no shimmering glyph, so nothing is written to it.
      expect(shimmerGlyph("background")).toBeNull();
      expect(
        screen.getByTestId("chat-dock-chip-background").querySelector("svg")
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
  // terminal either way, and it is the shimmer and the tone that say which. A
  // regression that reintroduced a state-dependent glyph would have to break
  // this and the row above it together.
  it("keeps the terminal glyph on a running managed shell", () => {
    renderStrip({
      chips: [
        { ...chipWithGlyph("background", "managedShell"), working: true },
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const chipElement = screen.getByTestId("chat-dock-chip-background");
    expect(drawnIcon(chipElement)).toBe("terminal");
    expect(chipElement.querySelector("svg.lucide-circle-pause")).toBeNull();
    expect(shimmerGlyph("background")).not.toBeNull();
    expect(iconClasses(chipElement)).toContain("text-primary");
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
