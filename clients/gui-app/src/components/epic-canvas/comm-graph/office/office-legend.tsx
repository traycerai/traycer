/**
 * What the floor's signals mean.
 *
 * COLLAPSED BY DEFAULT, and deliberately so: the office exists to be readable
 * at a glance, and a key permanently covering a corner of it would be an
 * admission that it is not. It is here for the first look and for the two
 * signals that are genuinely arbitrary - which envelope colour is a reply, and
 * which bubble means a person is needed.
 */
import { useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OFFICE_ENVELOPE_TINTS } from "@/components/epic-canvas/comm-graph/office/office-envelope-tints";

interface LegendEntry {
  readonly signal: string;
  readonly meaning: string;
}

const POSTURE_ENTRIES: ReadonlyArray<LegendEntry> = [
  { signal: "Typing", meaning: "working" },
  { signal: "Dim screen", meaning: "idle" },
  { signal: "…", meaning: "waiting for a reply" },
  { signal: "!", meaning: "needs you" },
  { signal: "Ghosted", meaning: "archived" },
];

const ENVELOPE_ENTRIES: ReadonlyArray<{
  readonly tint: string;
  readonly meaning: string;
}> = [
  { tint: OFFICE_ENVELOPE_TINTS.request, meaning: "request" },
  { tint: OFFICE_ENVELOPE_TINTS.reply, meaning: "reply" },
  { tint: OFFICE_ENVELOPE_TINTS.notice, meaning: "notice" },
  { tint: OFFICE_ENVELOPE_TINTS.created, meaning: "created" },
];

export function OfficeLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute right-2 bottom-2 z-10 flex flex-col items-end gap-1">
      {!open ? null : (
        <div
          className={cn(
            "max-w-64 rounded-md border border-border bg-popover p-2",
            "text-popover-foreground shadow-md",
          )}
          data-testid="comm-graph-office-legend-card"
        >
          <ul className="flex flex-col gap-0.5 text-ui-xs">
            {POSTURE_ENTRIES.map((entry) => (
              <li key={entry.signal} className="flex items-baseline gap-1.5">
                <span className="font-medium">{entry.signal}</span>
                <span className="text-muted-foreground">{entry.meaning}</span>
              </li>
            ))}
          </ul>
          <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-border pt-1.5 text-ui-xs">
            {ENVELOPE_ENTRIES.map((entry) => (
              <li key={entry.meaning} className="flex items-center gap-1.5">
                {/* The swatch IS the legend entry - naming the colour in words
                    would only be checkable against the floor by eye anyway. */}
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-xs"
                  style={{ backgroundColor: entry.tint }}
                />
                <span className="text-muted-foreground">
                  Envelope: {entry.meaning}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-expanded={open}
        aria-label="What the office signals mean"
        data-testid="comm-graph-office-legend-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        <Info aria-hidden />
      </Button>
    </div>
  );
}
