import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The `*` badge that marks a tier row's value as a PATTERN rather than one
 * model - in the Model cell, in the combobox's pattern option, and on a chat's
 * destination menu row the host could not resolve.
 *
 * The replacement for the old "family" tag, and a glyph rather than a word for
 * the reason the spec gives: the badge IS the syntax (`*` is the only
 * wildcard), so the thing that marks a pattern is also the thing that teaches
 * how to write one.
 *
 * Its text alternative is "pattern" (spec §Accessibility): the glyph is
 * `aria-hidden` and the word rides beside it for assistive technology, so a
 * trigger reads "*opus*, pattern, 2 models" rather than "star opus star star".
 *
 * `destructive` is for a pattern the user has to fix - one that matches
 * nothing, or reaches a model another tier owns. Otherwise it wears the brand
 * accent, `primary`: the neutral `accent` token is too weak to read as a mark
 * on a raised surface (clients/gui-app/AGENTS.md).
 */
export function FallbackPatternGlyph(props: {
  readonly tone: "accent" | "destructive";
}): ReactNode {
  return (
    <span
      className={cn(
        "inline-grid size-4.5 shrink-0 place-items-center rounded-sm pt-0.5 font-mono text-ui-sm leading-none font-bold",
        props.tone === "destructive"
          ? "bg-destructive/10 text-destructive"
          : "bg-primary/15 text-primary",
      )}
      data-testid="fallback-pattern-glyph"
    >
      <span aria-hidden>*</span>
      <span className="sr-only">pattern</span>
    </span>
  );
}
