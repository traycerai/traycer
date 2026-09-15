import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

interface LiveSubgroupProps {
  readonly title: string;
  readonly description: string | null;
  readonly icon: ReactNode;
  readonly control: ReactNode;
  readonly open: boolean;
  readonly level: 3 | 4;
  readonly dataTestId: string | undefined;
  readonly children: ReactNode;
}

/**
 * A `SettingsSubgroup` whose TITLE is live - one card per provider the watched
 * host has reported.
 *
 * `SettingsSubgroup` takes its label and anchor from a definition, so a card
 * whose subject is discovered at runtime cannot use it: there is no static
 * member to index. These reach search through the Usage limits entry that
 * encloses them, and this draws them in exactly its shape.
 */
export function LiveSubgroup(props: LiveSubgroupProps): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const Heading = props.level === 3 ? "h3" : "h4";
  return (
    <div
      className={cn(
        "border-b border-border/40 last:border-b-0",
        compact ? "px-4 py-2.5" : "px-5 py-3.5",
      )}
    >
      <div
        data-testid={props.dataTestId}
        className="overflow-hidden rounded-lg border border-border/60 bg-foreground/3"
      >
        <div
          className={cn(
            "flex flex-wrap items-start justify-between gap-x-6 gap-y-2",
            compact ? "px-3 py-2" : "px-4 py-3",
            props.open && "border-b border-border/40",
          )}
        >
          <div className="min-w-[50%] flex-1 space-y-1">
            <Heading className="flex items-center gap-2 font-medium text-foreground">
              {props.icon}
              {props.title}
            </Heading>
            {props.description === null ? null : (
              <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
                {props.description}
              </p>
            )}
          </div>
          {props.control === null ? null : (
            <div className="ml-auto flex max-w-full shrink-0 justify-end">
              {props.control}
            </div>
          )}
        </div>
        {props.open ? props.children : null}
      </div>
    </div>
  );
}
