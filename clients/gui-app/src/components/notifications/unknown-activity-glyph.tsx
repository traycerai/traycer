import { CircleDashed } from "lucide-react";

interface UnknownActivityGlyphProps {
  readonly testId: string | undefined;
}

/**
 * Shared visual for "this device is not served activity for this agent's
 * machine" - `AgentActivityCoverage` `"unserved"` (`lib/agent-activity.ts`).
 *
 * A dashed outline rather than a warning tone, and muted rather than
 * destructive: nothing is broken. The serving host built a union that does not
 * reach this machine (a local-served plane is the normal free-tier and
 * cloud-sync-off shape), so the only honest reading is that the app does not
 * know - which is a quieter statement than any of the attention tones and must
 * not compete with them for the eye.
 *
 * Deliberately NOT animated: motion reads as progress, and there is none to
 * report. It is the calmest glyph in the family for the same reason
 * `BackgroundActivityGlyph` is calmer than the spinner.
 */
export function UnknownActivityGlyph(props: UnknownActivityGlyphProps) {
  return (
    <CircleDashed
      aria-hidden
      className="size-3.5 text-muted-foreground/70"
      data-testid={props.testId}
    />
  );
}
