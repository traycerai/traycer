import { CalendarClock } from "lucide-react";

interface BackgroundActivityGlyphProps {
  readonly testId: string | undefined;
}

/** Shared visual for confirmed background-only activity. */
export function BackgroundActivityGlyph(props: BackgroundActivityGlyphProps) {
  return (
    <CalendarClock
      aria-hidden
      className="size-3.5 text-muted-foreground"
      data-testid={props.testId}
    />
  );
}
