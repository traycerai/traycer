import { useId, useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { GettingStartedCards } from "@/components/onboarding/getting-started-cards";
import {
  isPermanentlyUnavailable,
  useGettingStartedChecklist,
} from "@/components/onboarding/getting-started-checklist";

/** The Home tab's own section heading, so this reads as one of its bands. */
const HEADING_CLASS_NAME = "tracking-[0.08em] uppercase";

/**
 * The Getting started checklist on the Home tab. Open while anything is left
 * to do; once every guide this shell can offer is complete it folds into one
 * row, closed each time Home mounts, so a finished checklist costs the page a
 * single line.
 *
 * A guide the build can never offer is left out entirely rather than drawn
 * disabled: it is no part of the count, and a card that can only say so is
 * not worth a slot on Home.
 */
export function HomeGettingStartedSection(): ReactNode {
  const { entries, complete, guideCount } = useGettingStartedChecklist();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const offered = entries.filter((entry) => !isPermanentlyUnavailable(entry));
  const count = (
    <span className="flex items-center gap-1.5 tabular-nums">
      {complete === guideCount ? (
        <Check
          className="size-3.5 text-[var(--term-ansi-green)]"
          aria-hidden="true"
        />
      ) : null}
      {complete} of {guideCount} complete
    </span>
  );
  const cards = <GettingStartedCards entries={offered} surface="home" />;
  return (
    <section
      data-testid="home-getting-started"
      aria-labelledby={headingId}
      className="@container flex flex-col gap-1"
    >
      {complete < guideCount ? (
        <>
          <div className="flex items-center justify-between gap-3 px-3 pt-4 pb-1 text-ui-xs text-muted-foreground">
            <h2 id={headingId} className={HEADING_CLASS_NAME}>
              Getting started
            </h2>
            {count}
          </div>
          {cards}
        </>
      ) : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <h2 id={headingId}>
            <CollapsibleTrigger
              render={
                <button
                  type="button"
                  className="group mt-3 flex w-full items-center justify-between gap-3 rounded-sm px-3 py-1 text-ui-xs text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
                >
                  <span className="flex items-center gap-1.5">
                    <ChevronRight
                      className="size-3.5 text-muted-foreground transition-transform group-data-[open]:rotate-90 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                    <span className={HEADING_CLASS_NAME}>Getting started</span>
                  </span>
                  {count}
                </button>
              }
            />
          </h2>
          <CollapsibleContent className="pt-2">{cards}</CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
