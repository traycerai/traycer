import type { KeyboardEvent, ReactNode } from "react";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  isHostOptionSelectable,
  type HostPickIntent,
} from "@/components/settings/host-scope/host-option-model";
import { cn } from "@/lib/utils";

/**
 * How much room the rows take. The list is the same list either way — this is
 * the one concession to the surfaces it sits in, and it moves padding and type
 * scale only, never what a row says or which rows there are.
 *
 * - `compact`: a section inside another popover (the workspace selector, the
 *   worktree pickers), where the host block is one of several and must not
 *   out-weigh the folders under it.
 * - `roomy`: the standalone Select host dialog, where the list IS the content
 *   and compact rows would float in the middle of a modal.
 */
export type HostOptionListDensity = "compact" | "roomy";

const DENSITY_ROW_CLASS: Record<HostOptionListDensity, string> = {
  compact: "gap-2 rounded-md px-1.5 py-1 text-ui-sm",
  roomy: "min-h-11 gap-3 rounded-lg px-3 py-2.5 text-ui",
};

const DENSITY_LIST_CLASS: Record<HostOptionListDensity, string> = {
  compact: "gap-0.5",
  roomy: "gap-1",
};

/**
 * How the chosen row is marked, beyond the check every row shares.
 *
 * Compact sections sit under a "Host" heading among other sections, where a
 * filled row would compete with the folder selection below it — the check and
 * the brighter text carry it, as they always have there. The dialog is a
 * standalone "pick one" surface whose rows previously WERE filled buttons, and
 * dropping to a check alone in that much space lost the answer at a glance.
 */
const DENSITY_PICKED_CLASS: Record<HostOptionListDensity, string> = {
  compact: "",
  roomy: "bg-accent/60",
};

/**
 * The host list for every picker that is NOT a combobox — the sections
 * embedded in the workspace/worktree popovers and the shell's Select host
 * dialog. `HostSwitcher` renders the same rows inside cmdk items instead,
 * because it owns a search box and keyboard navigation this list has no
 * business duplicating.
 *
 * Radio semantics rather than a list of buttons: exactly one host is the
 * answer at a time, which is what a radiogroup means and what these rows have
 * always drawn with their check. The dialog already said so; the popover
 * sections said it visually and told assistive tech nothing.
 */
export function HostOptionList(props: {
  readonly hosts: readonly HostScopeOption[];
  /** The row that draws the check — the active host on every `bind` surface. */
  readonly pickedHostId: string | null;
  readonly activeHostId: string | null;
  readonly intent: HostPickIntent;
  readonly onSelect: (hostId: string) => void;
  /**
   * A pending submission owns the host selection. The rows go inert, not just
   * handler-less: an interactive row that silently discards the click reads as
   * a broken control rather than a busy one.
   */
  readonly disabled: boolean;
  readonly density: HostOptionListDensity;
  readonly label: string;
  /** Container-owned, because each surface's tests and copy already name it. */
  readonly testIdPrefix: string;
  readonly emptyLabel: string;
}): ReactNode {
  if (props.hosts.length === 0) {
    return (
      <p
        className="rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground"
        data-testid={`${props.testIdPrefix}-empty`}
      >
        {props.emptyLabel}
      </p>
    );
  }
  // The keyboard contract `role="radiogroup"` promises: ONE tab stop for the
  // group, arrows to move between rows. The roving stop is the picked row when
  // it can be re-chosen here, else the first selectable row. Arrows move FOCUS
  // only — activation stays on Enter/Space — because choosing a host here can
  // switch scope or rebind a surface, which select-on-focus would fire on
  // every arrow press.
  const rovingHostId =
    props.hosts.find(
      (host) =>
        host.hostId === props.pickedHostId &&
        isHostOptionSelectable(host, props.intent),
    )?.hostId ??
    props.hosts.find((host) => isHostOptionSelectable(host, props.intent))
      ?.hostId ??
    null;
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      // Focusable for the a11y contract but NOT a tab stop: the roving row
      // below is the group's single Tab target.
      tabIndex={-1}
      onKeyDown={moveRadioFocusOnArrow}
      className={cn("flex min-w-0 flex-col", DENSITY_LIST_CLASS[props.density])}
    >
      {props.hosts.map((host) => (
        <HostOptionListRow
          key={host.hostId}
          host={host}
          picked={host.hostId === props.pickedHostId}
          active={host.hostId === props.activeHostId}
          intent={props.intent}
          onSelect={props.onSelect}
          disabled={props.disabled}
          density={props.density}
          rovingTabStop={host.hostId === rovingHostId}
          testId={`${props.testIdPrefix}-${host.hostId}`}
        />
      ))}
    </div>
  );
}

/**
 * Container-level arrow handling, reading the rendered rows rather than
 * mirroring the selectability rules in state: a disabled button is exactly a
 * row the rules made unselectable, so the DOM already IS the selectable list.
 */
function moveRadioFocusOnArrow(event: KeyboardEvent<HTMLDivElement>): void {
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
  if (!forward && !backward) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]:enabled',
    ),
  );
  if (rows.length === 0) return;
  const active = document.activeElement;
  const current = rows.findIndex((row) => row === active);
  const next =
    current === -1
      ? rows[0]
      : rows[(current + (forward ? 1 : -1) + rows.length) % rows.length];
  event.preventDefault();
  next.focus();
}

function HostOptionListRow(props: {
  readonly host: HostScopeOption;
  readonly picked: boolean;
  readonly active: boolean;
  readonly intent: HostPickIntent;
  readonly onSelect: (hostId: string) => void;
  readonly disabled: boolean;
  readonly density: HostOptionListDensity;
  /** The group's single Tab stop; every other row is arrow-reachable only. */
  readonly rovingTabStop: boolean;
  readonly testId: string;
}): ReactNode {
  const { host } = props;
  // Two reasons a row cannot be chosen, and they are not the same reason: the
  // surface is busy, or this host is not a legal answer for what choosing means
  // here. Both end in `disabled`, but only the second is explained on the row
  // itself (`hostOptionStatusWord`), because only the second is about the host.
  const unselectable = !isHostOptionSelectable(host, props.intent);
  const disabled = props.disabled || unselectable;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.picked}
      disabled={disabled}
      tabIndex={props.rovingTabStop ? 0 : -1}
      data-testid={props.testId}
      data-selected={props.picked ? "true" : "false"}
      data-plan-restricted={host.planRestricted ? "true" : "false"}
      onClick={() => {
        props.onSelect(host.hostId);
      }}
      className={cn(
        "flex w-full items-center transition-colors",
        DENSITY_ROW_CLASS[props.density],
        "hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        props.picked ? "text-foreground" : "text-muted-foreground",
        props.picked && DENSITY_PICKED_CLASS[props.density],
        // Inert, but still legible: these rows carry the one word that explains
        // why they cannot be picked, and fading them to the usual disabled
        // opacity would hide the explanation along with the row.
        "disabled:pointer-events-none",
        props.disabled && "opacity-60",
      )}
    >
      <HostOptionRow
        host={host}
        picked={props.picked}
        active={props.active}
        intent={props.intent}
      />
    </button>
  );
}
