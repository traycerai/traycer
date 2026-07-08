import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
  sortProviderStatesByProviderOrder,
} from "@/lib/provider-ordering";
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
  readonly onSelect: ((providerId: ProviderId) => void) | null;
}

export function ProviderList(props: {
  readonly rows: ReadonlyArray<ProviderListRow>;
  readonly variant: ProviderListVariant;
  readonly ariaLabel: string;
  readonly className: string;
}) {
  const { rows, variant, ariaLabel, className } = props;
  const orderedRows = sortProviderStatesByProviderOrder(rows);
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
  const onSelect = row.onSelect;
  const rowContent = (
    <>
      <div className={innerClassName()}>
        <HarnessIcon
          harnessId={providerIdToGuiHarnessId(row.providerId)}
          className={iconClassName(variant, row.dimmed)}
        />
        <span className={labelClassName(variant, row.dimmed)}>
          {providerDisplayName(row.providerId)}
        </span>
        {row.badge}
        {trailingFor(row, variant)}
      </div>
      {row.description !== null ? (
        <div className={descriptionClassName(variant)}>{row.description}</div>
      ) : null}
    </>
  );

  return (
    <li className={liClassName(variant)}>
      {onSelect === null ? (
        <div className={rowClassName(variant, row.active, row.dimmed)}>
          {rowContent}
        </div>
      ) : (
        <button
          type="button"
          aria-label={providerDisplayName(row.providerId)}
          data-active={row.active}
          onClick={() => onSelect(row.providerId)}
          className={rowClassName(variant, row.active, row.dimmed)}
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

function liClassName(variant: ProviderListVariant): string {
  if (variant === "onboarding") return "flex flex-col gap-1";
  return "min-w-0";
}

function innerClassName(): string {
  return "flex w-full min-w-0 items-center gap-2.5";
}

function rowClassName(
  variant: ProviderListVariant,
  active: boolean,
  dimmed: boolean,
): string {
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
  return cn("min-w-0", dimmed && "opacity-60");
}

function iconClassName(variant: ProviderListVariant, dimmed: boolean): string {
  if (variant === "onboarding") {
    return cn("size-4", dimmed ? "text-white/35" : "text-white/85");
  }
  if (variant === "diorama") return "size-3.5 shrink-0";
  return "";
}

function labelClassName(variant: ProviderListVariant, dimmed: boolean): string {
  if (variant === "settings") return "min-w-0 flex-1 truncate";
  if (variant === "diorama") return "min-w-0 flex-1 truncate";
  return cn("text-ui-sm", dimmed ? "text-white/40" : "text-white/85");
}

function descriptionClassName(variant: ProviderListVariant): string {
  if (variant === "onboarding") {
    return "min-w-0 truncate pl-[1.625rem] text-ui-xs text-white/45";
  }
  return "min-w-0 truncate";
}
