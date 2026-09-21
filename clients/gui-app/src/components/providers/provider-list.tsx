import { useId, type CSSProperties, type ReactNode } from "react";
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
  /**
   * The row's SECOND LINE in the onboarding act's phone list: a short status,
   * plus the discovery counts when the provider reports any. `null` on every
   * other surface, which renders `description` instead.
   *
   * A separate slot rather than a narrower `description`, because the two are
   * not the same statement rendered twice: the card's line is a dot, a tooltip
   * and an info glyph, and a phone row has no room for a hover affordance and
   * no pointer to open one with. The act builds both and the list renders
   * whichever shape is on screen (see `phone` below), so the unrendered one
   * mounts nothing.
   */
  readonly phoneDescription: ReactNode | null;
}

export function ProviderList(props: {
  readonly rows: ReadonlyArray<ProviderListRow>;
  readonly variant: ProviderListVariant;
  readonly ariaLabel: string;
  readonly className: string;
  /**
   * Render the onboarding act's PHONE shape: a grouped list of rows rather
   * than a board of cards. Read once by the caller and passed down, so fifteen
   * rows do not take fifteen media-query subscriptions. Inert for every other
   * variant.
   */
  readonly phone: boolean;
}) {
  const { rows, variant, ariaLabel, className, phone } = props;
  const orderedRows =
    variant === "onboarding" ? rows : sortProviderStatesByProviderOrder(rows);
  return (
    <ul aria-label={ariaLabel} className={cn("flex flex-col", className)}>
      {orderedRows.map((row, index) => (
        <ProviderListItem
          key={row.providerId}
          row={row}
          variant={variant}
          index={index}
          phone={phone}
        />
      ))}
    </ul>
  );
}

/** Entry-stagger cap: past a dozen cards the last one would land a beat late. */
const ONBOARDING_STAGGER_CAP = 12;
/**
 * The phone list's own cap, lower because its rows are shorter: eight 64pt
 * rows is already the whole visible column, and a ninth delay would be a beat
 * the user waits through with nothing left to see arrive.
 */
const ONBOARDING_PHONE_STAGGER_CAP = 8;

function ProviderListItem(props: {
  readonly row: ProviderListRow;
  readonly variant: ProviderListVariant;
  readonly index: number;
  readonly phone: boolean;
}) {
  const { row, variant } = props;
  const descriptionId = useId();
  const onSelect = row.onSelect;
  if (variant === "onboarding" && props.phone) {
    return (
      <OnboardingProviderRow
        row={row}
        index={props.index}
        descriptionId={descriptionId}
      />
    );
  }
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
          // `dimmed` is the onboarding act's INSTALL channel, not its
          // enablement one: a card the user has nothing to do with recedes,
          // while an installed provider that is merely off stays fully legible
          // so its one affordance reads as the thing to press.
          data-recessive={row.dimmed}
          style={
            {
              "--i": Math.min(props.index, ONBOARDING_STAGGER_CAP),
            } as CSSProperties
          }
        >
          <button
            type="button"
            aria-label={providerDisplayName(row.providerId)}
            aria-pressed={row.enabled === true}
            aria-describedby={descriptionId}
            // A card with a REASON stays in the tab order so the reason it
            // describes can be reached; only a card with nothing to say is
            // natively disabled.
            aria-disabled={onSelect === null || undefined}
            disabled={onSelect === null && row.disabledReason === null}
            onClick={() => {
              if (onSelect === null) return;
              onSelect(row.providerId);
            }}
            className="onboarding-provider-toggle flex min-w-0 flex-1 flex-col items-start gap-1.5 p-4 text-left"
          >
            <span className="flex w-full min-w-0 items-center gap-2.5">
              <HarnessIcon
                harnessId={providerIdToGuiHarnessId(row.providerId)}
                className="size-6 shrink-0"
              />
              <span className={labelClassName(variant)}>
                {providerDisplayName(row.providerId)}
              </span>
              <span
                aria-hidden="true"
                className="onboarding-provider-check ml-auto flex size-[1.125rem] shrink-0 items-center justify-center rounded-full"
              >
                <Check className="size-3" strokeWidth={3} />
              </span>
            </span>
            <span
              id={descriptionId}
              className="onboarding-provider-status-line flex min-h-4 w-full min-w-0 items-center gap-2"
            >
              {row.description ?? row.badge}
              {row.disabledReason !== null ? (
                <span className="sr-only"> {row.disabledReason}</span>
              ) : null}
            </span>
          </button>
          {/* Hidden by CSS when the act supplies no footer content - a
              not-installed card is one line and nothing else. */}
          <div className="onboarding-provider-footer relative mt-auto flex min-w-0 flex-col items-stretch gap-2 px-4 pb-3.5">
            {row.trailing}
          </div>
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
        <span className={labelClassName(variant)}>
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

/**
 * The phone shape of an onboarding provider row: a 28pt glyph, the provider's
 * name over one merged status line, and a switch at the trailing edge.
 *
 * The row is the SINGLE control, exactly as the card is - same `aria-pressed`,
 * same disabled rules - and the switch beside it is presentational
 * (`aria-hidden`), drawn in CSS from `data-enabled` on the row. Two controls
 * would put a 44pt target inside a 64pt one and make the row's own tap
 * ambiguous.
 *
 * A row for a CLI the machine does not have carries no switch and no press: on
 * a card the toggle was still there because the card had room to explain
 * itself, but a phone row's whole second line is already spent saying "Not
 * installed", and offering to enable a binary that is not there is an
 * invitation to a failure. An installed-but-enabled row keeps its switch
 * whatever the install probe says, so a provider whose CLI was removed can
 * still be turned off.
 */
function OnboardingProviderRow(props: {
  readonly row: ProviderListRow;
  readonly index: number;
  readonly descriptionId: string;
}) {
  const { row, descriptionId } = props;
  const onSelect = row.onSelect;
  const installed = !row.dimmed;
  const offersToggle = row.enabled !== null && (installed || row.enabled);
  const content = (
    <>
      <HarnessIcon
        harnessId={providerIdToGuiHarnessId(row.providerId)}
        className="onboarding-provider-row-glyph size-7 shrink-0"
      />
      <span className="onboarding-provider-row-text">
        <span className="onboarding-provider-row-name">
          {providerDisplayName(row.providerId)}
        </span>
        <span id={descriptionId} className="onboarding-provider-row-meta">
          {row.phoneDescription}
          {/* The refusal has no tooltip to live in here - there is no pointer
              to open one - so it is only ever the row's accessible name. */}
          {row.disabledReason === null ? null : (
            <span className="sr-only"> {row.disabledReason}</span>
          )}
        </span>
      </span>
      {offersToggle ? (
        <span aria-hidden="true" className="onboarding-provider-switch">
          <span className="onboarding-provider-switch-thumb" />
        </span>
      ) : null}
    </>
  );
  return (
    <li
      className="onboarding-provider-row"
      data-enabled={row.enabled === true}
      data-installed={installed}
      style={
        {
          "--i": Math.min(props.index, ONBOARDING_PHONE_STAGGER_CAP),
        } as CSSProperties
      }
    >
      {offersToggle ? (
        <button
          type="button"
          aria-label={providerDisplayName(row.providerId)}
          aria-pressed={row.enabled}
          aria-describedby={descriptionId}
          aria-disabled={onSelect === null || undefined}
          disabled={onSelect === null && row.disabledReason === null}
          onClick={() => {
            if (onSelect === null) return;
            onSelect(row.providerId);
          }}
          className="onboarding-provider-row-button"
        >
          {content}
        </button>
      ) : (
        <div className="onboarding-provider-row-button">{content}</div>
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

function labelClassName(variant: ProviderListVariant): string {
  if (variant === "settings") return "min-w-0 flex-1 truncate";
  if (variant === "diorama") return "min-w-0 flex-1 truncate";
  // Onboarding: the name is the card's first line of hierarchy and never
  // recedes on its own - the whole card recedes together (`data-recessive`),
  // so this no longer forks on the row's dimmed flag. The class is what that
  // rule reaches it by (`onboarding-agents.css`).
  return "onboarding-provider-name min-w-0 truncate text-sm font-medium text-foreground";
}
