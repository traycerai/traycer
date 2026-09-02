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

interface LegendSection {
  readonly title: string;
  readonly entries: ReadonlyArray<LegendEntry>;
}

/**
 * Every representation the floor uses, grouped by WHERE you look for it.
 * A key that documents only the newest additions is worse than none: the
 * reader cannot tell which of the things they are looking at are in it.
 */
const SECTIONS: ReadonlyArray<LegendSection> = [
  {
    title: "People",
    entries: [
      { signal: "Typing", meaning: "working" },
      { signal: "…", meaning: "waiting for a reply" },
      { signal: "!", meaning: "needs you" },
      { signal: "At reception", meaning: "queued for you" },
      {
        signal:
          "Cafeteria, cooler, window, sofa, paper toss, watering plants, peeking, strolling",
        meaning: "idle",
      },
      { signal: "Ghosted", meaning: "archived" },
    ],
  },
  {
    title: "Desks",
    entries: [
      { signal: "Lit screen", meaning: "working" },
      { signal: "Dim screen", meaning: "idle" },
      { signal: "Cracked screen", meaning: "a turn failed" },
      { signal: "Screen size", meaning: "model size" },
      { signal: "Nameplate logo", meaning: "harness" },
      { signal: "Envelope pile", meaning: "unanswered requests" },
      { signal: "Dust sheet, boxes", meaning: "archived" },
    ],
  },
  {
    title: "Room",
    entries: [
      { signal: "Cabin", meaning: "one per root agent" },
      {
        signal: "Pods",
        meaning:
          "a sub-team inside its lead's cabin; outline style and floor tint change per level",
      },
      { signal: "Floor", meaning: "one per host" },
      { signal: "Wall clock", meaning: "the time being shown" },
      {
        signal: "Cafeteria",
        meaning: "break room; agents chat at the cooler and tables",
      },
      {
        signal: "Game room",
        meaning: "ping-pong and arcade for idle agents",
      },
    ],
  },
];

/**
 * The four envelope colours. A swatch rather than a colour name: the name
 * would only be checkable against the floor by eye anyway, and these come from
 * the same constants the renderer tints with.
 */
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
            "max-h-80 max-w-64 overflow-y-auto rounded-md border border-border",
            "bg-popover p-2",
            "text-popover-foreground shadow-md",
          )}
          data-testid="comm-graph-office-legend-card"
        >
          {SECTIONS.map((section) => (
            <div key={section.title} className="mb-1.5 last:mb-0">
              <p className="text-ui-xs font-medium text-muted-foreground">
                {section.title}
              </p>
              <ul className="flex flex-col gap-0.5 text-ui-xs">
                {section.entries.map((entry) => (
                  <li
                    key={entry.signal}
                    className="flex items-baseline gap-1.5"
                  >
                    <span className="font-medium">{entry.signal}</span>
                    <span className="text-muted-foreground">
                      {entry.meaning}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <ul className="flex flex-col gap-0.5 border-t border-border pt-1.5 text-ui-xs">
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
