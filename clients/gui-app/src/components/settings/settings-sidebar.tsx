import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import {
  singleDigitLeaderDigitFor,
  useSettingsLeaderModifierForIndex,
} from "@/providers/keybinding-context";
import { LeaderDigitBadge } from "@/components/ui/leader-digit-badge";
import { leaderHint } from "@/components/ui/leader-digit-shortcuts";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export type SettingsSidebarMode =
  | { readonly kind: "route" }
  | {
      readonly kind: "modal";
      readonly activeSection: SettingsSectionId;
      readonly onSelect: (section: SettingsSectionId) => void;
    };

export interface SettingsSidebarProps {
  readonly mode: SettingsSidebarMode;
}

export function SettingsSidebar(props: SettingsSidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-1 border-r border-border/60 bg-background p-4">
      <div className="flex flex-col gap-1">
        {SETTINGS_SECTIONS.map((section, index) => (
          <SettingsSidebarItem
            key={section.id}
            section={section}
            index={index}
            mode={props.mode}
          />
        ))}
      </div>
    </aside>
  );
}

interface SettingsSidebarItemProps {
  section: SettingsSection;
  index: number;
  mode: SettingsSidebarMode;
}

function SettingsSidebarItem(props: SettingsSidebarItemProps) {
  const { section, index, mode } = props;
  const badgeModifier = useSettingsLeaderModifierForIndex(index);
  const Icon = section.icon;
  const digit = singleDigitLeaderDigitFor(index);
  const baseClass =
    "inline-flex items-center gap-3 rounded-md px-3 py-2 text-ui-sm transition-colors";
  const badge = (
    <span className="flex min-w-5 justify-end">
      <AnimatePresence initial={false}>
        {badgeModifier === null ? null : (
          <LeaderDigitBadge
            key={`${badgeModifier}:${section.id}`}
            digit={digit}
            modifier={badgeModifier}
            ariaLabel={leaderHint(digit, "to open", section.label)}
            testId={`settings-section-digit-${digit}`}
            className="text-muted-foreground"
          />
        )}
      </AnimatePresence>
    </span>
  );
  if (mode.kind === "modal") {
    const active = mode.activeSection === section.id;
    return (
      <button
        type="button"
        data-testid={`settings-sidebar-item-${section.id}`}
        onClick={() => {
          Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
            source: "direct_ui",
            section: section.id,
          });
          mode.onSelect(section.id);
        }}
        className={cn(
          baseClass,
          "text-left",
          active
            ? "bg-accent text-accent-foreground"
            : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground",
        )}
      >
        <Icon className="size-4" />
        <span className="flex-1">{section.label}</span>
        {badge}
      </button>
    );
  }
  return <SettingsSidebarRouteItem section={section} badge={badge} />;
}

function SettingsSidebarRouteItem(props: {
  readonly section: SettingsSection;
  readonly badge: React.ReactNode;
}) {
  const { section, badge } = props;
  const Icon = section.icon;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname.startsWith(`/settings/${section.id}`);
  return (
    <Link
      to={`/settings/${section.id}`}
      replace
      onClick={() => {
        Analytics.getInstance().track(AnalyticsEvent.SettingsOpened, {
          source: "direct_ui",
          section: section.id,
        });
      }}
      className={cn(
        "inline-flex items-center gap-3 rounded-md px-3 py-2 text-ui-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground",
      )}
    >
      <Icon className="size-4" />
      <span className="flex-1">{section.label}</span>
      {badge}
    </Link>
  );
}
