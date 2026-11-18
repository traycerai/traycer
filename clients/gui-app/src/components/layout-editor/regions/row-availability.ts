import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  isDesktopLayoutRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";

/**
 * How the layout form says a row depends on something (P1): one context, one
 * closed answer, one resolver, one row shell.
 *
 * A row has no visible effect unless something else allows it - another row
 * (Side tab view needs tabs at a side), the window (the tab strip is not drawn
 * in the phone layout), or a fact the form can know (Voice input decides the
 * microphone). Every such row declares it beside itself in the registry, as a
 * {@link RowDependency}: the row it sits UNDER, which is what nests and orders
 * it, and a pure rule over one {@link LayoutFormContext} that answers with a
 * {@link RowAvailability}. Both form hosts and every row kind (fine-tune,
 * style, position, area row, list member) draw that answer through the same
 * shell (`inspector/rows/row-availability-line.tsx`), so there is one way to
 * say a row is off.
 *
 * The answer is closed on purpose:
 *
 * - `live` - the row works. A `note` says what a RUNTIME fact decides (a model
 *   with one effort level, a harness that cannot compact): the form cannot
 *   know it, so it never disables for it. `outlivesGate` keeps it working
 *   while its area is turned off as a whole (its region Hidden, or the phone
 *   layout's footer off), because something outside the area still reads it.
 * - `disabled` - another row (or a setting on another page) makes this one do
 *   nothing. The `reason` names that controller and the value to pick, and a
 *   `jump` lands on the controller itself where it is out of sight.
 * - `absent` - no setting and no window size can ever make it apply on this
 *   device (the tab strip in the installed app). Never for a narrow window
 *   that could be widened: that is a `note`.
 */

/** What the form can know at runtime that no layout value says. */
export interface LayoutFacts {
  /** General > Voice input, which the composer's microphone follows. */
  readonly voiceInputEnabled: boolean;
}

/**
 * Whether two reads of the facts say the same thing, field by field. Typed
 * as a record over every key, so a fact added above does not compile until it
 * is compared here too, and a cache keyed on facts can never go stale on it.
 */
export function sameLayoutFacts(
  left: LayoutFacts,
  right: LayoutFacts,
): boolean {
  const same: Record<keyof LayoutFacts, boolean> = {
    voiceInputEnabled: left.voiceInputEnabled === right.voiceInputEnabled,
  };
  return Object.values(same).every(Boolean);
}

/** Everything a row's rule may read, built once per render by one hook. */
export interface LayoutFormContext {
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
  /** The shell, including whether its phone layout is drawn (`phoneLayout`). */
  readonly shell: SettingsAvailabilityContext;
  readonly facts: LayoutFacts;
}

/**
 * Where a reason's link lands: the controller row itself, never only its
 * section. `label` is the link's own words.
 */
export type RowJump =
  | {
      readonly kind: "settings";
      readonly section: SettingsSectionId;
      /** The row's search anchor, as a search result reveals it. */
      readonly anchor: string | null;
      readonly label: string;
    }
  | {
      readonly kind: "layout-region";
      readonly regionId: RegionId;
      /**
       * A list row inside the region's own section, by its id, when that row
       * is the controller (a provider in Usage limits' Profiles), else `null`.
       */
      readonly row: string | null;
      readonly label: string;
    };

export type RowAvailability =
  | {
      readonly kind: "live";
      readonly note: string | null;
      readonly outlivesGate: boolean;
    }
  | {
      readonly kind: "disabled";
      readonly reason: string;
      readonly jump: RowJump | null;
    }
  | { readonly kind: "absent" };

/** What a drawn row can be: everything but `absent`, which is never drawn. */
export type ShownRowAvailability = Exclude<
  RowAvailability,
  { readonly kind: "absent" }
>;

export type RowRule = (context: LayoutFormContext) => RowAvailability;

/**
 * Whether a shell can ever draw a region at all (the installed app has no
 * dictation and no hover rail). Where it says no the region is `absent`: no
 * row in the form and no search result, both read off this one predicate.
 */
export type ShellGate = (shell: SettingsAvailabilityContext) => boolean;

/**
 * A region's own rule, in a shell its {@link ShellGate} lets draw it: never
 * `absent`, since saying so is the gate's job alone.
 */
export type RegionRule = (context: LayoutFormContext) => ShownRowAvailability;

/**
 * What a row depends on, declared beside it in the registry.
 *
 * `under` is the id of the row it sits under among its own section's rows -
 * a region's detail rows, or an area's own rows - which is what nests it one
 * level and places it right after that row. Declaration order is the only
 * order: a row never moves because a value changed, so the dependent that is
 * live at the shipped default is declared first.
 */
export interface RowDependency {
  readonly under: string | null;
  readonly availability: RowRule;
}

export const LIVE: ShownRowAvailability = {
  kind: "live",
  note: null,
  outlivesGate: false,
};

export const ABSENT: RowAvailability = { kind: "absent" };

export function liveWithNote(note: string): ShownRowAvailability {
  return { kind: "live", note, outlivesGate: false };
}

/**
 * A row something outside its area still reads (the Resource monitor's
 * Metrics, which agent rows follow, L-174): live even while the area's gate
 * turns the rest off, so the gate's hint names only the rest.
 */
export function liveOutsideGate(note: string | null): ShownRowAvailability {
  return { kind: "live", note, outlivesGate: true };
}

/** Whether a row stays live while its area is turned off as a whole. */
export function outlivesGate(availability: RowAvailability): boolean {
  return availability.kind === "live" && availability.outlivesGate;
}

export function disabledBy(
  reason: string,
  jump: RowJump | null,
): ShownRowAvailability {
  return { kind: "disabled", reason, jump };
}

/** The words a row's availability adds, or `null` for a plain live row. */
export function rowAvailabilityText(
  availability: ShownRowAvailability,
): string | null {
  return availability.kind === "disabled"
    ? availability.reason
    : availability.note;
}

export const alwaysLive: RegionRule = () => LIVE;

/** A row that depends on nothing: most of them. */
export const INDEPENDENT: RowDependency = {
  under: null,
  availability: alwaysLive,
};

/**
 * Several answers for one row, as one: `absent` over everything, then the
 * first `disabled`, then `live` carrying every note in order, outliving the
 * gate only when every answer does.
 */
export function strictest(
  answers: ReadonlyArray<RowAvailability>,
): RowAvailability {
  if (answers.some((answer) => answer.kind === "absent")) return ABSENT;
  const disabled = answers.find((answer) => answer.kind === "disabled");
  if (disabled !== undefined) return disabled;
  const notes = answers.flatMap((answer) =>
    answer.kind === "live" && answer.note !== null ? [answer.note] : [],
  );
  return {
    kind: "live",
    note: notes.length === 0 ? null : notes.join(" "),
    outlivesGate: answers.every(outlivesGate),
  };
}

/** What a row only the desktop layout draws says in a narrow browser tab. */
export const WIDER_WINDOWS_NOTE = "Applies on wider windows.";

/**
 * A row only the desktop layout draws (the tab strip, the sidebar, the reading
 * column, where a reading sits): absent in the installed app, which is the
 * phone layout at every width, and live with a note in a narrow browser tab,
 * where widening the window is the way back. Keyed on the PHONE LAYOUT, the
 * predicate the renderer itself reads, never on the product alone.
 */
export function wideLayoutRow(
  shell: SettingsAvailabilityContext,
): RowAvailability {
  if (!isDesktopLayoutRowAvailable(shell)) return ABSENT;
  return shell.phoneLayout ? liveWithNote(WIDER_WINDOWS_NOTE) : LIVE;
}

/** One drawn row, where it sits and what it says about itself. */
export interface OrderedRow<Row> {
  readonly row: Row;
  /** 1 for a row drawn under its controller. One level, never deeper. */
  readonly depth: 0 | 1;
  readonly availability: ShownRowAvailability;
}

/**
 * A section's rows as the form draws them: each row that sits under nothing,
 * in declared order, followed straight away by the rows declared under it at
 * depth 1, in THEIR declared order; an absent row left out. Nothing else
 * reorders a row (see {@link RowDependency}).
 */
export function orderedRows<
  Row extends { readonly id: string; readonly depends: RowDependency },
>(
  rows: ReadonlyArray<Row>,
  context: LayoutFormContext,
): ReadonlyArray<OrderedRow<Row>> {
  const placed = rows
    .filter((row) => row.depends.under === null)
    .flatMap((root) => [
      { row: root, depth: 0 as const },
      ...rows
        .filter((row) => row.depends.under === root.id)
        .map((row) => ({ row, depth: 1 as const })),
    ]);
  // A row under a row that is itself nested, or under an id this section
  // does not have, would silently vanish: a registry mistake, loud where it
  // can be fixed.
  if (import.meta.env.DEV && placed.length !== rows.length) {
    throw new Error(
      `layout rows nest one level under a row of their own section: ${rows
        .map((row) => row.id)
        .join(", ")}`,
    );
  }
  return placed.flatMap(({ row, depth }) => {
    const availability = row.depends.availability(context);
    return availability.kind === "absent" ? [] : [{ row, depth, availability }];
  });
}
