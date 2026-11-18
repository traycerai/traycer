import { cleanup, render } from "@testing-library/react";
import { CirclePlay, Monitor, Radar, Terminal } from "lucide-react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";

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

function monitorGlyph(monitoring: boolean): string {
  return glyphOf(
    <ManagedCommandMonitorIcon
      monitoring={monitoring}
      decorative
      className={undefined}
    />,
  );
}

describe("<ManagedCommandMonitorIcon />", () => {
  afterEach(cleanup);

  it("draws a monitoring shell as Radar and a quiet one as CirclePlay", () => {
    expect(monitorGlyph(true)).toBe(lucideGlyph(Radar));
    expect(monitorGlyph(false)).toBe(lucideGlyph(CirclePlay));
    expect(monitorGlyph(true)).not.toBe(monitorGlyph(false));
  });

  it("avoids the two glyphs that would read as something else", () => {
    // `Monitor` is a display, not a watcher, and a terminal glyph would collide
    // with the Terminals surface next door.
    expect(monitorGlyph(true)).not.toBe(lucideGlyph(Monitor));
    expect(monitorGlyph(false)).not.toBe(lucideGlyph(Terminal));
  });

  it("swaps the glyph when the flag flips under a mounted row", () => {
    // `monitoring` is live-tunable, so the same row can stop being a watcher
    // without remounting. The swap is the depiction of that, which a glyph
    // chosen once at mount would swallow.
    const { container, rerender } = render(
      <ManagedCommandMonitorIcon monitoring decorative className={undefined} />,
    );
    expect(container.querySelector("[data-monitor-icon='on']")).not.toBeNull();

    rerender(
      <ManagedCommandMonitorIcon
        monitoring={false}
        decorative
        className={undefined}
      />,
    );
    expect(container.querySelector("[data-monitor-icon='on']")).toBeNull();
    expect(container.querySelector("[data-monitor-icon='off']")).not.toBeNull();
    expect(container.querySelector("svg")?.innerHTML).toBe(
      lucideGlyph(CirclePlay),
    );
  });

  it("speaks the monitor state where no neighbouring copy carries it", () => {
    const { container, rerender } = render(
      <ManagedCommandMonitorIcon
        monitoring
        decorative={false}
        className={undefined}
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Monitoring");
    // Colour on this surface means status; this icon must not compete.
    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");

    rerender(
      <ManagedCommandMonitorIcon
        monitoring={false}
        decorative={false}
        className={undefined}
      />,
    );
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Not monitoring",
    );
  });

  it("stays silent beside a title that already names the state", () => {
    // Every row/header title now says "Monitor · …" or "Shell · …", so a
    // speaking glyph there would announce the same fact twice.
    const { container } = render(
      <ManagedCommandMonitorIcon monitoring decorative className={undefined} />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(svg?.getAttribute("aria-label")).toBeNull();
  });
});
