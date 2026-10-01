import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The master-detail body a settings panel draws inside its shell card:
 * Settings ▸ Providers' layout, shared with Settings ▸ Layout (H2).
 *
 * From `md` up a rail column sits beside the detail column, both filling the
 * card, so switching the selection never resizes the box and the detail - not
 * the settings surface - owns the scroll. Below `md` the rail collapses into a
 * full-width select stacked above the detail, and the settings surface
 * scrolls the lot: a phone has one scroll container already, and a pane that
 * scrolls inside a page that also scrolls is two gestures competing for one
 * flick.
 *
 * The detail column carries the horizontal padding rather than each row, so a
 * body that owns the scroll cancels it with `-mx-5 px-5` and puts its
 * scrollbar on the pane edge instead of five units inside it.
 */
export function SettingsMasterDetail(props: {
  /** The rail's landmark name. */
  readonly railLabel: string;
  /** The rail's contents, pointer widths only. */
  readonly rail: ReactNode;
  /** The same selection below `md`, usually a `SettingsMasterSelect`. */
  readonly mobileSelect: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col md:h-full md:min-h-0 md:flex-row">
      <div className="shrink-0 border-b border-border/60 p-2 md:hidden">
        {props.mobileSelect}
      </div>
      {/* A share of the CARD, not of the window: the settings pane can be
          narrow in a wide window (the modal beside its own section rail), and
          a rail sized off the viewport took its full 14rem there and left the
          detail too narrow for a row's name. */}
      <nav
        aria-label={props.railLabel}
        className="hidden w-[clamp(10rem,28%,14rem)] shrink-0 flex-col border-r border-border/60 md:flex"
      >
        {props.rail}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col px-5 pt-5 md:min-h-0">
        {props.children}
      </div>
    </div>
  );
}

/**
 * The detail column's head: what is selected, one line on what it is, and an
 * action for it at the trailing edge. Pinned from `md` up, above whatever the
 * detail scrolls.
 */
export function SettingsDetailHeader(props: {
  readonly title: string;
  /** A live badge beside the title, or `null`. */
  readonly badge: ReactNode;
  readonly description: string;
  /** Anything under the description (a provider's auth line), or `null`. */
  readonly footer: ReactNode;
  readonly action: ReactNode;
}): ReactNode {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="font-medium text-foreground">{props.title}</div>
          {props.badge}
        </div>
        <p className="text-ui-sm text-muted-foreground">{props.description}</p>
        {props.footer}
      </div>
      {props.action}
    </div>
  );
}

export interface SettingsMasterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Drawn before the label, in the list and in the closed trigger alike. */
  readonly icon: ReactNode;
  /** After the label (the layout page's changed dot), or `null`. */
  readonly trailing: ReactNode;
}

/**
 * The rail's phone presentation: one select over the same options. The icon
 * rides the closed trigger too, because `SelectItem` portals the selected
 * item's text - icon included - into it.
 */
export function SettingsMasterSelect<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<SettingsMasterOption<Value>>;
  readonly onSelect: (value: Value) => void;
}): ReactNode {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        // Resolved through the options rather than asserting the select's
        // string back into `Value`.
        const match = props.options.find((option) => option.value === value);
        if (match !== undefined) props.onSelect(match.value);
      }}
    >
      <SelectTrigger aria-label={props.label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex min-w-0 items-center gap-2">
              {option.icon}
              <span className="min-w-0 truncate">{option.label}</span>
              {option.trailing}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
