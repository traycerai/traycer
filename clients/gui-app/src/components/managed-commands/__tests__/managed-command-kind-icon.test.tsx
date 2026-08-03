import { cleanup, render } from "@testing-library/react";
import { CirclePlay, Monitor, Radar, Terminal } from "lucide-react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedCommandKindIcon } from "@/components/managed-commands/managed-command-kind-icon";
import type { ManagedCommandKind } from "@traycer/protocol/host/managed-command/unary-schemas";

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

function kindGlyph(kind: ManagedCommandKind): string {
  return glyphOf(<ManagedCommandKindIcon kind={kind} className={undefined} />);
}

describe("<ManagedCommandKindIcon />", () => {
  afterEach(cleanup);

  it("draws a monitor as Radar and a shell as CirclePlay", () => {
    expect(kindGlyph("monitor")).toBe(lucideGlyph(Radar));
    expect(kindGlyph("shell")).toBe(lucideGlyph(CirclePlay));
    expect(kindGlyph("monitor")).not.toBe(kindGlyph("shell"));
  });

  it("avoids the two glyphs that would read as something else", () => {
    // `Monitor` is a display, not a watcher, and a terminal glyph would collide
    // with the Terminals surface next door.
    expect(kindGlyph("monitor")).not.toBe(lucideGlyph(Monitor));
    expect(kindGlyph("shell")).not.toBe(lucideGlyph(Terminal));
  });

  it("is decorative: the kind is always carried by neighbouring words", () => {
    const { container } = render(
      <ManagedCommandKindIcon kind="monitor" className={undefined} />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    // Colour on this surface means status; the kind icon must not compete.
    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");
  });
});
