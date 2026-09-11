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

/** The blink writes this straight onto the icon; "" is a chip at rest. */
function iconOpacity(section: string): string {
  const icon = screen
    .getByTestId(`chat-dock-chip-${section}`)
    .querySelector("svg");
  return icon instanceof SVGElement ? icon.style.opacity : "missing";
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
    // A resting chip is the bare icon: no activity wrapper, no corner mark.
    for (const section of ["filesChanged", "activeAgents", "background"]) {
      const chipElement = screen.getByTestId(`chat-dock-chip-${section}`);
      expect(chipElement.querySelector("[data-chip-activity]")).toBeNull();
      expect(iconOpacity(section)).toBe("");
    }
  });

  // The whole of this: a working chip keeps SAYING what it is. The icon is the
  // only thing that does, so activity blinks it rather than taking its place.
  it("blinks the section's own icon while a chip is working, and keeps its number", () => {
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
    // Stronger than the chip's muted inherit, so the blink's dim half has
    // something to step down from.
    expect(iconClasses(agents)).toContain("text-foreground");
    const wrapper = agents.querySelector("[data-chip-activity]");
    expect(wrapper).not.toBeNull();
    // The corner mark below is absolutely positioned against this wrapper.
    expect(wrapper?.getAttribute("class")).toContain("relative");
    expect(agents.textContent).toBe("2");

    const background = screen.getByTestId("chat-dock-chip-background");
    expect(drawnIcon(background)).toBe("alarm-clock");
    expect(iconClasses(background)).not.toContain("text-foreground");
    expect(background.querySelector("[data-chip-activity]")).toBeNull();
  });

  // Reduced motion cannot rely on the pulse, so the same fact is stated as a
  // mark that is simply there - shown by media query, never by a second prop.
  it("carries a corner mark for reduced motion only while working", () => {
    renderStrip({
      chips: [
        { ...chipWithGlyph("activeAgents", "activeAgents"), working: true },
        chipWithGlyph("background", "wakeup"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const dot = screen
      .getByTestId("chat-dock-chip-activeAgents")
      .querySelector("[data-chip-activity-dot]");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("class")).toContain("hidden");
    expect(dot?.getAttribute("class")).toContain("motion-reduce:block");
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
        { ...chipWithGlyph("activeAgents", "activeAgents"), working: true },
        { ...chipWithGlyph("background", "monitor"), working: true },
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const strip = screen.getByTestId("chat-dock-compact-strip");
    expect(strip.querySelector(".working-dots")).toBeNull();
    expect(strip.textContent).toBe("11");
    for (const element of strip.querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(
        /(^|[\s:])animate-/,
      );
    }
  });

  // The blink is driven from the app's one status clock, not from CSS: two
  // opacities, stepped, with every working chip in the window on the same
  // tick. Driven here exactly as the spinner's own suite drives it.
  describe("clock-driven blink", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetStatusAnimationClockForTests();
    });

    afterEach(() => {
      cleanup();
      resetStatusAnimationClockForTests();
      vi.useRealTimers();
    });

    it("steps the working icon between two opacities across the cycle", () => {
      renderStrip({
        chips: [
          { ...chipWithGlyph("activeAgents", "activeAgents"), working: true },
          chipWithGlyph("background", "wakeup"),
        ],
        expanded: new Set(),
        onToggle: vi.fn(),
      });

      // Written pre-paint, so the first frame is already in place.
      expect(iconOpacity("activeAgents")).toBe("1");

      act(() => {
        vi.advanceTimersByTime(640);
      });
      expect(iconOpacity("activeAgents")).toBe("0.4");

      act(() => {
        vi.advanceTimersByTime(640);
      });
      expect(iconOpacity("activeAgents")).toBe("1");

      // A resting chip is never written to, however long the clock runs.
      expect(iconOpacity("background")).toBe("");
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
    // A managed shell rests only once it is held, so it draws the panel's
    // held glyph rather than any kind icon.
    ["managedShell", "circle-pause"],
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
