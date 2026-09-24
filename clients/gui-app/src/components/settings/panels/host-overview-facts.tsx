import type { ReactNode } from "react";
import { CopyTextButton } from "@/components/copy-text-button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * A group's facts as a label-over-value grid: one column on a phone, up to
 * three across a wide pane. The Installation tab's About this host and Install
 * record both read this way, so a host's account facts and its install facts
 * share one shape. Sized by the CARD's width (a container query), not the
 * viewport's: the Settings pane is narrower than the window beside its
 * sidebar.
 */
export function HostOverviewFacts(props: {
  readonly children: ReactNode;
  readonly testId: string;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <div className="@container">
      <dl
        className={cn(
          "grid grid-cols-1 gap-x-6 @sm:grid-cols-2 @xl:grid-cols-3",
          compact ? "gap-y-2.5 px-4 py-3" : "gap-y-3.5 px-5 py-4",
        )}
        data-testid={props.testId}
      >
        {props.children}
      </dl>
    </div>
  );
}

/** How a fact's value is set: an identifier in mono, a sentence in body type. */
export type HostOverviewFactKind = "code" | "text";

/** A value that reads as good news, as needing a look, or as neither. */
export type HostOverviewFactTone = "default" | "success" | "warning";

/**
 * One fact. A `copy` value puts a copy button beside it and copies the WHOLE
 * value, which is what lets `value` show an identifier shortened - the full
 * one is in the tooltip and on the clipboard.
 *
 * The tooltip wraps the value AND its copy button, so the full value is not a
 * pointer-only fact: hovering either shows it, and so does focusing the button
 * (focus bubbles to the trigger), which is the one stop a keyboard makes here.
 */
export function HostOverviewFact(props: {
  readonly label: string;
  readonly value: string;
  readonly kind: HostOverviewFactKind;
  readonly tone: HostOverviewFactTone;
  readonly copy: { readonly value: string; readonly label: string } | null;
  readonly testId: string | undefined;
}): ReactNode {
  const { copy } = props;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-ui-xs uppercase tracking-wide text-muted-foreground">
        {props.label}
      </dt>
      <dd className="flex min-w-0">
        <TooltipWrapper
          label={copy === null ? null : copy.value}
          side="top"
          sideOffset={undefined}
          align="start"
        >
          <span className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                "min-w-0 break-all text-foreground",
                props.kind === "code" ? "font-mono text-code-xs" : "text-ui-sm",
                props.tone === "success" && "text-success-foreground",
                props.tone === "warning" && "text-warning-foreground",
              )}
              data-testid={props.testId}
            >
              {props.value}
            </span>
            {copy === null ? null : (
              <CopyTextButton
                value={copy.value}
                label={null}
                ariaLabel={copy.label}
                disabled={false}
              />
            )}
          </span>
        </TooltipWrapper>
      </dd>
    </div>
  );
}
