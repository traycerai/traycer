import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { harnessDisplayName } from "@/components/session-import/session-import-model";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";

/** This is the unread idiom instead: a quiet dot by the title that disappears the first time the task is
 * opened. */
export function ImportedUnseenDot(props: { readonly epicId: string }) {
  const harness = useImportedUnseenStore((state) => state.unseen[props.epicId]);
  if (harness === undefined) return null;
  return (
    <TooltipWrapper
      label={`Imported from ${harnessDisplayName(harness)} - not opened yet`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        data-testid="imported-unseen-dot"
        role="img"
        aria-label={`Imported from ${harnessDisplayName(harness)}, not opened yet`}
        className="size-1.5 shrink-0 rounded-full bg-primary"
      />
    </TooltipWrapper>
  );
}
