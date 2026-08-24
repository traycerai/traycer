import { type ReactNode } from "react";
import {
  Boxes,
  Braces,
  Gauge,
  KeyRound,
  Puzzle,
  Server,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProviderTabKey } from "./provider-settings-tabs";

/**
 * One glyph per section, so a row is recognisable before its label is read.
 *
 * EXHAUSTIVE `Record`, not a partial one: a section added to
 * `PROVIDER_TAB_ORDER` without an icon would otherwise render an empty box on
 * phones and nothing at all would mark the omission. The compiler asks instead.
 */
const PROVIDER_SECTION_ICONS: Record<ProviderTabKey, LucideIcon> = {
  account: KeyRound,
  usage: Gauge,
  general: SquareTerminal,
  env: Braces,
  modelProviders: Boxes,
  mcp: Server,
  plugins: Puzzle,
  skills: Sparkles,
};

/**
 * The phone presentation of the provider section rail: a dropdown naming the
 * active section, over one plain row per supported section.
 *
 * Why a dropdown rather than the desktop tab bar. Below `md` that bar wraps
 * into two ragged rows, and it is the FOURTH row of chrome on that screen
 * (mobile crumb header -> provider select -> provider header -> rail), so the
 * wrap pushes content off the fold. A dropdown spends ONE row whatever the
 * section count, and it is the same gesture one row above it: the provider
 * itself is picked from a `Select` (`ProvidersMobileSelect`), so picking a
 * section now reads as the same kind of choice rather than a second, bespoke
 * one.
 *
 * Rows are label-only (icon + name), deliberately. A row that also carried the
 * section's state ("No key", "2 profiles") is two lines tall and bordered by
 * its neighbours' spacing - a card in a menu's clothing, which is what this
 * replaced. That state belongs in the section BODY, which is one tap away and
 * shows it in full rather than in a caption.
 *
 * Selection is driven through `onSelect` rather than through Radix tab
 * triggers: a `Select` item cannot also be a `Tabs` trigger. `Tabs` stays
 * CONTROLLED by the panel either way, so the one-mounted-pane invariant - MCP /
 * Plugins / Skills / Model Providers each drive their own host queries and
 * unbounded lists, and exactly one may be live - is untouched by the swap.
 */
export function ProviderSectionSelect({
  tabs,
  activeTab,
  onSelect,
  labelFor,
}: {
  readonly tabs: readonly ProviderTabKey[];
  readonly activeTab: ProviderTabKey;
  readonly onSelect: (tab: ProviderTabKey) => void;
  readonly labelFor: (tab: ProviderTabKey) => string;
}): ReactNode {
  return (
    <Select
      value={activeTab}
      onValueChange={(value) => {
        // Resolve through the supported list instead of asserting the select's
        // string value back into the `ProviderTabKey` union.
        const next = tabs.find((tab) => tab === value);
        if (next !== undefined) onSelect(next);
      }}
    >
      {/* Not disabled for a one-section provider. The grid this replaced
          disabled its expander there, because "All sections" over a grid of one
          promised a choice that was not there - but a select's closed state is
          a VALUE, not that promise, and opening it onto its own single row is
          what every select does. Disabling would instead fade the only section
          name on the screen to `opacity-50`. */}
      <SelectTrigger aria-label="Section" className="w-full shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {tabs.map((tab) => {
          const Icon = PROVIDER_SECTION_ICONS[tab];
          return (
            // `SelectItem` wraps its children in Radix's `ItemText`, which
            // portals the SELECTED item into the trigger - so the icon rides
            // the closed state too, from this one place.
            <SelectItem key={tab} value={tab}>
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{labelFor(tab)}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
