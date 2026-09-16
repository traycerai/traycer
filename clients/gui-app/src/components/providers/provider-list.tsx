import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
  sortProviderStatesByProviderOrder,
} from "@/lib/provider-ordering";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

export type ProviderListVariant = "settings" | "onboarding" | "diorama";

export interface ProviderListRow {
  readonly providerId: ProviderId;
  readonly active: boolean;
  readonly dimmed: boolean;
  readonly enabled: boolean | null;
  readonly badge: ReactNode | null;
  readonly description: ReactNode | null;
  readonly trailing: ReactNode | null;
  readonly disabledReason: string | null;
  readonly onSelect: ((providerId: ProviderId) => void) | null;
}

export function ProviderList(props: {
  readonly rows: ReadonlyArray<ProviderListRow>;
  readonly variant: ProviderListVariant;
  readonly ariaLabel: string;
  readonly className: string;
}) {
  const { rows, variant, ariaLabel, className } = props;
  const orderedRows =
    variant === "onboarding" ? rows : sortProviderStatesByProviderOrder(rows);
  return (
    <ul aria-label={ariaLabel} className={cn("flex flex-col", className)}>
      {orderedRows.map((row) => (
        <ProviderListItem key={row.providerId} row={row} variant={variant} />
      ))}
    </ul>
  );
}

function ProviderListItem(props: {
  readonly row: ProviderListRow;
  readonly variant: ProviderListVariant;
}) {
  const { row, variant } = props;
  const descriptionId = useId();
  const onSelect = row.onSelect;
  if (variant === "onboarding") {
    return (
      <TooltipWrapper
        label={row.disabledReason}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <li
          className="onboarding-provider-card relative flex min-w-0 flex-col"
          data-enabled={row.enabled === true}
        >
          <button
            type="button"
            aria-label={providerDisplayName(row.providerId)}
            aria-pressed={row.enabled === true}
            aria-describedby={descriptionId}
            disabled={onSelect === null}
            onClick={() => onSelect?.(row.providerId)}
            className="onboarding-provider-toggle flex min-w-0 flex-1 flex-col gap-2 rounded-xl p-4 text-left"
          >
            <span className="flex w-full min-w-0 items-center gap-2.5">
              <HarnessIcon
                harnessId={providerIdToGuiHarnessId(row.providerId)}
                className={cn(
                  "size-6 shrink-0 transition-opacity",
                  row.dimmed && "opacity-50",
                )}
              />
              <span className={labelClassName(variant, row.dimmed)}>
                {providerDisplayName(row.providerId)}
              </span>
              <span
                aria-hidden="true"
                className="onboarding-provider-check ml-auto flex size-4 shrink-0 items-center justify-center rounded-full"
              >
                <Check className="size-3" />
              </span>
            </span>
            <span id={descriptionId} className="min-h-4 text-ui-sm">
              {row.description ?? row.badge}
              {row.disabledReason !== null ? (
                <span className="sr-only"> {row.disabledReason}</span>
              ) : null}
            </span>
          </button>
          {row.trailing !== null ? (
            <div className="relative mt-auto px-4 pb-3">{row.trailing}</div>
          ) : null}
        </li>
      </TooltipWrapper>
    );
  }
  const rowContent = (
    <>
      <div className={innerClassName()}>
        <HarnessIcon
          harnessId={providerIdToGuiHarnessId(row.providerId)}
          className={variant === "diorama" ? "size-3.5 shrink-0" : ""}
        />
        <span className={labelClassName(variant, row.dimmed)}>
          {providerDisplayName(row.providerId)}
        </span>
        {row.badge}
        {trailingFor(row, variant)}
      </div>
      {row.description !== null ? (
        <div className="min-w-0 truncate">{row.description}</div>
      ) : null}
    </>
  );

  return (
    <li className="min-w-0">
      {onSelect === null ? (
        <div className={rowClassName(variant, row.active)}>{rowContent}</div>
      ) : (
        <button
          type="button"
          aria-label={providerDisplayName(row.providerId)}
          data-active={row.active}
          onClick={() => onSelect(row.providerId)}
          className={rowClassName(variant, row.active)}
        >
          {rowContent}
        </button>
      )}
    </li>
  );
}

function trailingFor(
  row: ProviderListRow,
  variant: ProviderListVariant,
): ReactNode {
  if (row.trailing !== null) return row.trailing;
  if (variant !== "settings" || row.enabled !== false) return null;
  return (
    <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
  );
}

function innerClassName(): string {
  return "flex w-full min-w-0 items-center gap-2.5";
}

function rowClassName(variant: ProviderListVariant, active: boolean): string {
  if (variant === "settings") {
    return cn(
      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-ui-sm transition-colors",
      active
        ? "bg-accent text-accent-foreground"
        : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground",
    );
  }
  if (variant === "diorama") {
    return cn(
      "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-ui-xs",
      active ? "bg-accent text-accent-foreground" : "text-foreground/80",
    );
  }
  return "flex h-full min-w-0 flex-col";
}

function labelClassName(variant: ProviderListVariant, dimmed: boolean): string {
  if (variant === "settings") return "min-w-0 flex-1 truncate";
  if (variant === "diorama") return "min-w-0 flex-1 truncate";
  return cn(
    "min-w-0 truncate text-sm font-medium",
    dimmed ? "text-muted-foreground" : "text-foreground",
  );
}
