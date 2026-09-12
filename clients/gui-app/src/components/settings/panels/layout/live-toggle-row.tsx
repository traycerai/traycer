import { useId, type ReactNode } from "react";
import { SettingsRowDescriptionContext } from "@/components/settings/settings-row-description";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * A row whose LABEL is live - one provider, one of its windows - rendered
 * without `SettingsRow`.
 *
 * `SettingsRow` takes everything it says from a definition, which is what
 * makes a row and its search entry the same object. These have no definition
 * and cannot have one: the set exists only for providers the watched host has
 * reported, so there is nothing static to index. They reach search through the
 * enclosing entry instead, and this draws them in the shape the primitive
 * would.
 */
export function LiveToggleRow(props: {
  readonly label: string;
  readonly description: string | null;
  readonly control: ReactNode;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const descriptionId = useId();
  const described = props.description !== null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border/40 last:border-b-0",
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div className="min-w-[50%] flex-1 space-y-1">
        <div className="font-medium text-foreground">{props.label}</div>
        {described ? (
          <p
            id={descriptionId}
            className="max-w-[72ch] break-words text-pretty text-ui-sm text-muted-foreground"
          >
            {props.description}
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex max-w-full shrink-0 justify-end">
        {/* The control reaches its description the same way `SettingsRow`'s
          does, so a group inside one is announced with the rule that governs
          it rather than with its label alone. */}
        <SettingsRowDescriptionContext.Provider
          value={described ? descriptionId : undefined}
        >
          {props.control}
        </SettingsRowDescriptionContext.Provider>
      </div>
    </div>
  );
}
