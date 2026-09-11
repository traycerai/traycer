import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_DOCK_CHIP_WORKING_TEST_ID,
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

/** The lucide class naming the icon a chip drew, or null for a spinner. */
function drawnIcon(chipElement: HTMLElement): string | null {
  const svg = chipElement.querySelector("svg");
  if (svg === null) return null;
  const match = /\blucide-([a-z0-9-]+)/.exec(svg.getAttribute("class") ?? "");
  return match?.[1] ?? null;
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
    expect(screen.queryByTestId(CHAT_DOCK_CHIP_WORKING_TEST_ID)).toBeNull();
  });

  it("replaces the icon with the spinner while a chip is working, and keeps its number", () => {
    renderStrip({
      chips: [
        { ...chipWithGlyph("activeAgents", "working"), text: "2" },
        chipWithGlyph("background", "wakeup"),
      ],
      expanded: new Set(),
      onToggle: vi.fn(),
    });

    const agents = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(
      within(agents).getByTestId(CHAT_DOCK_CHIP_WORKING_TEST_ID),
    ).not.toBeNull();
    expect(drawnIcon(agents)).toBeNull();
    expect(agents.textContent).toContain("2");

    const background = screen.getByTestId("chat-dock-chip-background");
    expect(
      within(background).queryByTestId(CHAT_DOCK_CHIP_WORKING_TEST_ID),
    ).toBeNull();
    expect(drawnIcon(background)).toBe("alarm-clock");
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
