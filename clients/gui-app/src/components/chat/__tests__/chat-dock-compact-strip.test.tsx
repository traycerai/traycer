/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import { resetStatusAnimationClockForTests } from "@/lib/animation/status-animation-clock";
import {
  ChatDockCompactStrip,
  ChatDockCompactStripProvider,
  type ChatDockCompactChipModel,
  type ChatDockCompactStripValue,
} from "@/components/chat/chat-dock-compact-strip";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";
import { TooltipProvider } from "@/components/ui/tooltip";

function chip(
  section: ChatDockSection,
  text: string,
): ChatDockCompactChipModel {
  return {
    section,
    glyph: section,
    hotspotRef: () => undefined,
    working: false,
    text,
    lineDeltas: null,
    label: `${section} label`,
    detail: `${section} detail`,
    pulseToken: null,
  };
}

function unitChip(section: ChatDockSection): ChatDockCompactChipModel {
  return chip(section, "1");
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

/**
 * `snapshotLoaded` is explicit at every call rather than defaulted, because it
 * is half of what decides whether a pill's arrival counts as news: the strip
 * arms itself one commit after it has drawn a pill over SETTLED data.
 */
function stripUi(value: ChatDockCompactStripValue, snapshotLoaded: boolean) {
  return (
    <TooltipProvider delay={0}>
      <ChatDockCompactStripProvider value={value}>
        <ChatDockCompactStrip
          actionsRef={() => undefined}
          snapshotLoaded={snapshotLoaded}
          onSettled={() => undefined}
        />
      </ChatDockCompactStripProvider>
    </TooltipProvider>
  );
}

function renderStrip(value: ChatDockCompactStripValue) {
  return render(stripUi(value, true));
}

function stripValue(
  chips: ReadonlyArray<ChatDockCompactChipModel>,
): ChatDockCompactStripValue {
  return {
    chips,
    openSection: null,
    panelId: "dock-panel-1",
    onToggle: vi.fn(),
  };
}

/**
 * The box that ENTERS and LEAVES for one pill: the strip's own direct child
 * holding that chip. Found by containment rather than by counting parents, so
 * a wrapper added or removed between the two does not silently re-point this
 * at something that never animates.
 */
function pillBox(section: string): HTMLElement {
  const strip = screen.getByTestId("chat-dock-compact-strip");
  const chip = screen.getByTestId(`chat-dock-chip-${section}`);
  const box = [...strip.children].find((child) => child.contains(chip));
  if (!(box instanceof HTMLElement)) throw new Error(`no pill box: ${section}`);
  return box;
}

describe("<ChatDockCompactStrip />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing outside a provider", () => {
    const { container } = render(
      <TooltipProvider delay={0}>
        <ChatDockCompactStrip
          actionsRef={() => undefined}
          snapshotLoaded
          onSettled={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing with an empty chip list", () => {
    const { container } = renderStrip({
      chips: [],
      openSection: null,
      panelId: "dock-panel-1",
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
      openSection: null,
      panelId: "dock-panel-1",
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
        unitChip("background"),
      ],
      openSection: null,
      panelId: "dock-panel-1",
      onToggle: vi.fn(),
    });

    expect(drawnIcon(screen.getByTestId("chat-dock-chip-filesChanged"))).toBe(
      "file-diff",
    );
    expect(drawnIcon(screen.getByTestId("chat-dock-chip-activeAgents"))).toBe(
      "bot",
    );
    expect(drawnIcon(screen.getByTestId("chat-dock-chip-background"))).toBe(
      "message-square-clock",
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
          ...unitChip("activeAgents"),
          text: "2",
          working: true,
        },
        unitChip("background"),
      ],
      openSection: null,
      panelId: "dock-panel-1",
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
    expect(drawnIcon(background)).toBe("message-square-clock");
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
        { ...unitChip("activeAgents"), working: true },
        { ...unitChip("background"), working: true },
      ],
      openSection: null,
      panelId: "dock-panel-1",
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
      "message-square-clock",
    );
  });

  // Nothing is drawn over the glyph, in either state. The corner dot that used
  // to sit there was the size of a third of the icon it overlapped, so a
  // running terminal read as a terminal with something stuck to it - and the
  // tone and the shimmer were already saying what the dot was there to say.
  it("draws nothing at a chip's corner, working or at rest", () => {
    renderStrip({
      chips: [
        { ...unitChip("activeAgents"), working: true },
        unitChip("background"),
      ],
      openSection: null,
      panelId: "dock-panel-1",
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
        { ...unitChip("activeAgents"), working: true },
        { ...unitChip("background"), working: true },
      ],
      openSection: null,
      panelId: "dock-panel-1",
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
          { ...unitChip("activeAgents"), working: true },
          unitChip("background"),
        ],
        openSection: null,
        panelId: "dock-panel-1",
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

  // The Background chip has ONE glyph - the section's own chat-with-a-clock -
  // in both states. It used to borrow the panel's per-kind icons and a neutral
  // stack when they mixed, so the same chip was a bot, a clock, a terminal or
  // a pile of layers depending on the panel's contents, and a reader scanning
  // for "the background chip" had to know those to find it. Neither a per-kind
  // icon nor `circle-pause` may come back: the state is the shimmer and the
  // tone, and a held shell is said in the chip's sentence.
  it("draws the section's own mark on a resting background chip", () => {
    renderStrip({
      chips: [unitChip("background")],
      openSection: null,
      panelId: "dock-panel-1",
      onToggle: vi.fn(),
    });

    const chipElement = screen.getByTestId("chat-dock-chip-background");
    expect(drawnIcon(chipElement)).toBe("message-square-clock");
    expect(chipElement.querySelector("svg.lucide-layers")).toBeNull();
    expect(chipElement.querySelector("svg.lucide-circle-pause")).toBeNull();
    expect(shimmerGlyph("background")).toBeNull();
  });

  it("keeps the same mark, lit, on a working background chip", () => {
    renderStrip({
      chips: [{ ...unitChip("background"), working: true }],
      openSection: null,
      panelId: "dock-panel-1",
      onToggle: vi.fn(),
    });

    const chipElement = screen.getByTestId("chat-dock-chip-background");
    expect(drawnIcon(chipElement)).toBe("message-square-clock");
    expect(chipElement.querySelector("svg.lucide-layers")).toBeNull();
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
      openSection: null,
      panelId: "dock-panel-1",
      onToggle: vi.fn(),
    });

    expect(screen.getByTestId("chat-dock-chip-filesChanged").textContent).toBe(
      "3+12−4",
    );
    expect(screen.getByTestId("chat-dock-chip-activeAgents").textContent).toBe(
      "2",
    );
  });

  // The most important claim in the strip's suite, and it is about the ABSENCE
  // of motion: opening a chat with five pills used to fire five attention
  // rings at once beside the input, because every pill's arrival and its mount
  // are the same instant and `pulseToken` fires on arrival. Nothing had
  // happened; the chat had merely been opened.
  describe("first paint", () => {
    const ALL_SECTIONS: ReadonlyArray<ChatDockSection> = [
      "filesChanged",
      "activeAgents",
      "background",
      "todo",
    ];

    it("rings no pill when a chat opens with four of them", () => {
      renderStrip(
        stripValue(
          ALL_SECTIONS.map((section) => ({
            ...unitChip(section),
            pulseToken: `${section}-arrived`,
          })),
        ),
      );

      for (const section of ALL_SECTIONS) {
        expect(
          screen
            .getByTestId(`chat-dock-chip-${section}`)
            .getAttribute("data-pulse"),
          section,
        ).toBeNull();
      }
    });

    // The other half, and the one the suppression must not cost: a pill that
    // genuinely arrives later - the first agent starting, a message landing in
    // the queue - is news and still rings.
    it("rings a pill that arrives after the strip has settled", () => {
      const { rerender } = renderStrip(
        stripValue([{ ...unitChip("filesChanged"), pulseToken: "changed" }]),
      );

      rerender(
        stripUi(
          stripValue([
            { ...unitChip("filesChanged"), pulseToken: "changed" },
            { ...unitChip("activeAgents"), pulseToken: "running" },
          ]),
          true,
        ),
      );

      expect(
        screen
          .getByTestId("chat-dock-chip-activeAgents")
          .getAttribute("data-pulse"),
      ).toBe("true");
      // ...and the pill that was already there is not dragged into ringing
      // with it.
      expect(
        screen
          .getByTestId("chat-dock-chip-filesChanged")
          .getAttribute("data-pulse"),
      ).toBeNull();
    });

    // The same failure through the other door, and the hole the first version
    // of the suppression left: `ChatLowerDock` mounts this strip whenever the
    // dock renders at all, so a chat whose members are a full Todo row and
    // three pill-sized ones mounts an EMPTY strip. "Has committed once" was
    // true one commit later, over no pills at all, and the first burst a turn
    // brought - files changed, an agent started, background activity began -
    // rang three rings at once. Mutation check: drop the `hasChips` term from
    // the effect
    // in `chat-dock-compact-strip.tsx` and this goes red.
    it("rings no pill in the first burst after an empty mount", () => {
      const BURST: ReadonlyArray<ChatDockSection> = [
        "filesChanged",
        "activeAgents",
        "background",
      ];
      const burst = BURST.map((section) => ({
        ...unitChip(section),
        pulseToken: `${section}-arrived`,
      }));
      const { rerender } = renderStrip(stripValue([]));

      rerender(stripUi(stripValue(burst), true));

      for (const section of BURST) {
        expect(
          screen
            .getByTestId(`chat-dock-chip-${section}`)
            .getAttribute("data-pulse"),
          section,
        ).toBeNull();
      }

      // And the strip is armed from there: the next pill to arrive is news.
      rerender(
        stripUi(
          stripValue([...burst, { ...unitChip("todo"), pulseToken: "todo" }]),
          true,
        ),
      );

      expect(
        screen.getByTestId("chat-dock-chip-todo").getAttribute("data-pulse"),
      ).toBe("true");
    });

    // The other half of the same condition. The pills are built from four
    // independently arriving sources, and two of them (Changed files, Todo)
    // are gated on the chat's snapshot while the background row is not - so a
    // strip can hold a pill before the snapshot lands, and would then be armed
    // for the burst the snapshot itself brings. Mutation check: drop the
    // `snapshotLoaded` term from the effect and this goes red.
    it("rings no pill in the burst the snapshot brings", () => {
      const { rerender } = render(
        stripUi(
          stripValue([{ ...unitChip("background"), pulseToken: "held-1" }]),
          false,
        ),
      );

      rerender(
        stripUi(
          stripValue([
            { ...unitChip("background"), pulseToken: "held-1" },
            { ...unitChip("filesChanged"), pulseToken: "changed" },
            { ...unitChip("todo"), pulseToken: "todo" },
          ]),
          true,
        ),
      );

      for (const section of ["background", "filesChanged", "todo"]) {
        expect(
          screen
            .getByTestId(`chat-dock-chip-${section}`)
            .getAttribute("data-pulse"),
          section,
        ).toBeNull();
      }
    });

    // `initial={false}` on the `AnimatePresence`, read off the paint rather
    // than off the prop: a pill present at the first commit is rendered AT its
    // resting values, and a pill that arrives later starts at the hidden ones
    // and animates up. Asserted as "1" against "0" rather than as an empty
    // style, because a motion element always writes the value it is holding.
    it("paints an opening chat's pills at rest and an arriving pill from hidden", () => {
      const { rerender } = renderStrip(stripValue([unitChip("filesChanged")]));

      expect(pillBox("filesChanged").style.opacity).toBe("1");

      rerender(
        stripUi(
          stripValue([unitChip("filesChanged"), unitChip("activeAgents")]),
          true,
        ),
      );

      expect(pillBox("activeAgents").style.opacity).toBe("0");
      expect(pillBox("filesChanged").style.opacity).toBe("1");
    });
  });

  // The bug this exists to catch (staging round 4): `AnimatePresence` +
  // `popLayout` held an exiting pill in the document at its own opacity, and a
  // section that returned before that exit had finished was revived as the
  // SAME node - back in flow, stuck invisible, holding its width and pushing
  // the pills after it off the composer's left edge. With no exit tracking, a
  // removed pill leaves the tree in the commit that removes it, so there is
  // nothing left to revive.
  it("removes a leaving pill from the DOM in the same commit, with no ghost left behind", () => {
    const chips = [unitChip("filesChanged"), unitChip("activeAgents")];
    const { rerender } = render(
      <LazyMotion features={domAnimation}>
        {stripUi(stripValue(chips), true)}
      </LazyMotion>,
    );
    expect(screen.getByTestId("chat-dock-chip-activeAgents")).not.toBeNull();

    rerender(
      <LazyMotion features={domAnimation}>
        {stripUi(stripValue([chips[0]]), true)}
      </LazyMotion>,
    );

    expect(screen.queryByTestId("chat-dock-chip-activeAgents")).toBeNull();
  });

  // The other half: a pill that comes back is a fresh mount rather than the
  // stale node `AnimatePresence` would have reused mid-exit - a reused node is
  // exactly what stayed frozen at the exit's opacity. Read off the hotspot
  // ref, the one hook that sees the actual DOM node the strip hands out.
  it("brings a removed pill back as a new element rather than reviving the old one", () => {
    const seen: Array<HTMLElement | null> = [];
    const hotspotRef = (node: HTMLElement | null) => {
      seen.push(node);
    };
    const chips = [
      unitChip("filesChanged"),
      { ...unitChip("activeAgents"), hotspotRef },
    ];
    const { rerender } = render(
      <LazyMotion features={domAnimation}>
        {stripUi(stripValue(chips), true)}
      </LazyMotion>,
    );
    const firstNode = seen.at(-1);
    expect(firstNode).not.toBeNull();

    rerender(
      <LazyMotion features={domAnimation}>
        {stripUi(stripValue([chips[0]]), true)}
      </LazyMotion>,
    );
    rerender(
      <LazyMotion features={domAnimation}>
        {stripUi(stripValue(chips), true)}
      </LazyMotion>,
    );

    const revivedNode = seen.at(-1);
    expect(revivedNode).not.toBeNull();
    expect(revivedNode).not.toBe(firstNode);
  });

  it("calls onToggle with the clicked chip's section", () => {
    const onToggle = vi.fn();
    renderStrip({
      chips: [chip("background", "2")],
      openSection: null,
      panelId: "dock-panel-1",
      onToggle,
    });

    fireEvent.click(screen.getByTestId("chat-dock-chip-background"));

    expect(onToggle).toHaveBeenCalledWith("background");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

/**
 * A motion decision jsdom cannot observe at all, so it is read off the source
 * the way `dock-chip-ring-css.test.ts` reads the stylesheet: a `layout` prop's
 * damage is the composer moving underneath, which is a painted fact about a
 * `flex-wrap` row and a rect that cannot be asserted from the DOM here and is
 * one word away from being lost in an edit.
 */
describe("the strip's motion contract", () => {
  const source = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "chat-dock-compact-strip.tsx",
    ),
    "utf8",
  );

  // The row is `flex-wrap` directly above the composer, so a layout animation
  // across a wrap boundary would animate the position of the input itself -
  // the one element on screen whose response has to be instant.
  it("animates no layout anywhere in the strip", () => {
    // Scoped to a motion element's OPENING TAG rather than to the whole file,
    // because `layout` is an ordinary English word this file's prose uses. The
    // previous spelling asked for `{` or end-of-line after the name, which
    // `<m.span layout className="...">` - the way the prop is normally written
    // - matched neither, so the one edit most likely to introduce it passed
    // silently. `[^>]*` cannot cross out of the tag, so a mention in a comment
    // below one is not a hit.
    expect(source).not.toMatch(
      /<m\.[a-z]+[^>]*\blayout(?:Id|Root|Dependency)?\b/,
    );
  });
});
