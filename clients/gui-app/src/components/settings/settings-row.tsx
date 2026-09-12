import { useId, type ReactNode } from "react";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { SettingsRowDescriptionContext } from "@/components/settings/settings-row-description";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

interface SettingsRowProps {
  /**
   * Everything the row says about itself — label, static description and the
   * settings-search anchor — comes from its definition, the same value the
   * search index reads, so a row cannot exist without being indexed or folded
   * into one that is (see `lib/settings-search/settings-definitions.ts`).
   */
  readonly row: SettingsRowDefinition;
  /**
   * Live copy shown INSTEAD of the definition's static description, in the
   * same described-by region. Selected by `!== undefined`: omitted (or
   * `undefined`) shows the static description, anything else replaces it — and
   * `null`, `false` or `""` replace it with nothing, which is a deliberate
   * suppression.
   */
  readonly status?: ReactNode;
  /**
   * A live badge beside the definition's static label — the label-line twin of
   * `status`. The row renders it after `row.label`, in the same label element,
   * behind its own " · " separator ("Light theme · Active"). Selected by
   * `!== undefined` like `status`; `null`, `false` or `""` render the bare
   * label. The definition's `label` stays the searchable copy.
   */
  readonly labelStatus?: ReactNode;
  hint?: ReactNode;
  readonly control: ReactNode;
}

export function SettingsRow(props: SettingsRowProps) {
  const { row, status, labelStatus, hint, control } = props;
  const compact = useSettingsDensity() === "compact";
  const descriptionId = useId();
  const showsStatus = status !== undefined;
  const described = showsStatus
    ? rendersContent(status)
    : rendersContent(row.description);
  const badged = labelStatus !== undefined && rendersContent(labelStatus);
  const descriptionClassName =
    "max-w-[72ch] break-words text-pretty text-ui-sm text-muted-foreground";
  return (
    <div
      data-settings-anchor={row.anchor ?? undefined}
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border/40 last:border-b-0",
        SETTINGS_ROW_STACK.container,
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div
        className={cn("min-w-[50%] flex-1 space-y-1", SETTINGS_ROW_STACK.label)}
      >
        <div className="font-medium text-foreground">
          {row.label}
          {badged ? (
            <>
              {" · "}
              {labelStatus}
            </>
          ) : null}
        </div>
        {described && showsStatus ? (
          // A `div`, not a `p`: a status is arbitrary content.
          <div id={descriptionId} className={descriptionClassName}>
            {status}
          </div>
        ) : null}
        {described && !showsStatus ? (
          <p id={descriptionId} className={descriptionClassName}>
            {row.description}
          </p>
        ) : null}
        {hint ? (
          <p className="text-ui-sm font-medium text-amber-700 dark:text-amber-300">
            {hint}
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "ml-auto flex max-w-full shrink-0 justify-end [&>*]:max-w-full",
          SETTINGS_ROW_STACK.control,
        )}
      >
        <SettingsRowDescriptionContext.Provider
          value={described ? descriptionId : undefined}
        >
          {control}
        </SettingsRowDescriptionContext.Provider>
      </div>
    </div>
  );
}

/** Whether a node draws anything — `null`, booleans and `""` draw nothing. */
function rendersContent(node: ReactNode): boolean {
  return (
    node !== null &&
    node !== undefined &&
    typeof node !== "boolean" &&
    node !== ""
  );
}
