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

/** Exhaustive `Record`, not a partial one: a section added to `PROVIDER_TAB_ORDER` without an icon would
 * otherwise render an empty box on phones and nothing at all would mark the omission. */
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

/** Why a dropdown rather than the desktop tab bar. Selection is driven through `onSelect` rather than through
 * Radix tab triggers: a `Select` item cannot also be a `Tabs` trigger. */
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
      {/* Disabling would instead fade the only section name on the screen to `opacity-50`. */}
      <SelectTrigger aria-label="Section" className="w-full shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {tabs.map((tab) => {
          const Icon = PROVIDER_SECTION_ICONS[tab];
          return (
            // `SelectItem` wraps its children in Radix's `ItemText`, which portals the selected item into the trigger - so
            // the icon rides the closed state too, from this one place.
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
