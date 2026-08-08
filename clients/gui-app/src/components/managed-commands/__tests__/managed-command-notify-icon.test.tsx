import { cleanup, render } from "@testing-library/react";
import { CirclePlay, Monitor, Radar, Terminal } from "lucide-react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedCommandNotifyIcon } from "@/components/managed-commands/managed-command-notify-icon";

/** The glyph's own path data, which is what actually identifies a lucide icon. */
function glyphOf(node: React.ReactElement): string {
  const { container } = render(node);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("no icon rendered");
  return svg.innerHTML;
}

function lucideGlyph(Icon: ComponentType): string {
  return glyphOf(<Icon />);
}

function notifyGlyph(notifying: boolean): string {
  return glyphOf(
    <ManagedCommandNotifyIcon notifying={notifying} className={undefined} />,
  );
}

describe("<ManagedCommandNotifyIcon />", () => {
  afterEach(cleanup);

  it("draws a notifying shell as Radar and a quiet one as CirclePlay", () => {
    expect(notifyGlyph(true)).toBe(lucideGlyph(Radar));
    expect(notifyGlyph(false)).toBe(lucideGlyph(CirclePlay));
    expect(notifyGlyph(true)).not.toBe(notifyGlyph(false));
  });

  it("avoids the two glyphs that would read as something else", () => {
    // `Monitor` is a display, not a watcher, and a terminal glyph would collide
    // with the Terminals surface next door.
    expect(notifyGlyph(true)).not.toBe(lucideGlyph(Monitor));
    expect(notifyGlyph(false)).not.toBe(lucideGlyph(Terminal));
  });

  it("swaps the glyph when the flag flips under a mounted row", () => {
    // `notifying` is live-tunable, so the same row can stop being a watcher
    // without remounting. The swap is the depiction of that, which a glyph
    // chosen once at mount would swallow.
    const { container, rerender } = render(
      <ManagedCommandNotifyIcon notifying className={undefined} />,
    );
    expect(container.querySelector("[data-notify-icon='on']")).not.toBeNull();

    rerender(
      <ManagedCommandNotifyIcon notifying={false} className={undefined} />,
    );
    expect(container.querySelector("[data-notify-icon='on']")).toBeNull();
    expect(container.querySelector("[data-notify-icon='off']")).not.toBeNull();
    expect(container.querySelector("svg")?.innerHTML).toBe(
      lucideGlyph(CirclePlay),
    );
  });

  it('speaks the notify state: the glyph is its only carrier now that every label says just "Shell"', () => {
    const { container, rerender } = render(
      <ManagedCommandNotifyIcon notifying className={undefined} />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Notifying");
    // Colour on this surface means status; this icon must not compete.
    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");

    rerender(
      <ManagedCommandNotifyIcon notifying={false} className={undefined} />,
    );
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Not notifying",
    );
  });
});
