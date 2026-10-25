import type { ReactNode } from "react";
import { GettingStartedCards } from "@/components/onboarding/getting-started-cards";
import { useGettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";

/** The Home tab's own section heading, so this reads as one of its bands. */
const HEADING_CLASS_NAME = "tracking-[0.08em] uppercase";

/**
 * The Getting started checklist on the Home tab. Hidden once every visible
 * step is done; E4 hides the Settings Guide group from the same fact.
 */
export function HomeGettingStartedSection(): ReactNode {
  const { entries, complete, guideCount, allDone } =
    useGettingStartedChecklist();
  if (allDone) return null;
  return (
    <section
      data-testid="home-getting-started"
      aria-labelledby="home-getting-started-heading"
      className="@container flex flex-col gap-1"
    >
      <div className="flex items-center justify-between gap-3 px-3 pt-4 pb-1 text-ui-xs text-muted-foreground">
        <h2 id="home-getting-started-heading" className={HEADING_CLASS_NAME}>
          Getting started
        </h2>
        <span className="tabular-nums">
          {complete} of {guideCount} complete
        </span>
      </div>
      <GettingStartedCards entries={entries} surface="home" />
    </section>
  );
}
