import { Fragment, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_GROUPS,
  type SettingsSection,
  type SettingsSectionGroupId,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import {
  singleDigitLeaderDigitFor,
  useSettingsLeaderModifierForIndex,
} from "@/providers/keybinding-context";
import { LeaderDigitBadge } from "@/components/ui/leader-digit-badge";
import { leaderHint } from "@/components/ui/leader-digit-shortcuts";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";

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

/**
 * The sidebar carries the scope model.
 *
 * Sections are grouped by what they belong to — this app, your account, or one
 * specific machine — and the machine group is headed by the ONE host switcher
 * in Settings. Everything indented beneath it is scoped by that selection,
 * which is what makes the rule learnable instead of memorised. See
 * `settings-sections.ts` for the grouping itself.
 */
export function SettingsSidebar(props: SettingsSidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 bg-background p-4">
      {SETTINGS_SECTION_GROUPS.map((group) => (
        <Fragment key={group.id}>
          <SettingsSidebarGroupHeader group={group.id} label={group.label} />
          <div
            className={cn(
              "flex flex-col gap-0.5",
              // The host group's items read as belonging to the switcher above
              // them, so they carry a small inset the ungrouped tiers don't.
              group.id === "host" && "mt-1 pl-1",
            )}
          >
            {SETTINGS_SECTIONS.map((section, index) =>
              section.group === group.id ? (
                <SettingsSidebarItem
                  key={section.id}
                  section={section}
                  index={index}
                  mode={props.mode}
                />
              ) : null,
            )}
          </div>
        </Fragment>
      ))}
    </aside>
  );
}

function SettingsSidebarGroupHeader(props: {
  readonly group: SettingsSectionGroupId;
  readonly label: string | null;
}): ReactNode {
  if (props.group === "host") return <SettingsSidebarHostHeader />;
  return (
    <h2 className="mt-3 mb-1 px-3 font-semibold text-ui-xs tracking-wide text-muted-foreground/70 uppercase first:mt-0">
      {props.label}
    </h2>
  );
}

/**
 * The host group's header IS the switcher — not a label above one. Putting the
 * control in the heading position is what says "these sections belong to this
 * machine" without a sentence of explanatory copy.
 */
function SettingsSidebarHostHeader(): ReactNode {
  const scope = useHostScope();
  const openAddHost = useAddHostDialogStore((s) => s.openDialog);
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <h2 className="px-3 font-semibold text-ui-xs tracking-wide text-muted-foreground/70 uppercase">
        Machine
      </h2>
      <HostSwitcher
        hosts={scope.hosts}
        selected={scope.host}
        onSelect={scope.setHostId}
        onAddHost={() =>
          openAddHost(scope.hosts.map((host) => host.hostId))
        }
        isLoading={scope.isLoading}
      />
    </div>
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
  const label = (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className="truncate">{section.label}</span>
      {section.thisMachineOnly ? <ThisMachineTag /> : null}
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
        <Icon className="size-4 shrink-0" />
        {label}
        {badge}
      </button>
    );
  }
  return (
    <SettingsSidebarRouteItem section={section} label={label} badge={badge} />
  );
}

function SettingsSidebarRouteItem(props: {
  readonly section: SettingsSection;
  readonly label: React.ReactNode;
  readonly badge: React.ReactNode;
}) {
  const { section, label, badge } = props;
  const Icon = section.icon;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname.startsWith(`/settings/${section.id}`);
  return (
    <Link
      to={`/settings/${section.id}`}
      replace
      data-testid={`settings-sidebar-item-${section.id}`}
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
      <Icon className="size-4 shrink-0" />
      {label}
      {badge}
    </Link>
  );
}

/**
 * Says the quiet part. Shell and Diagnostics read the local CLI / desktop
 * bridges, so they can only ever describe the machine the app is running on —
 * they sit outside the host group and this tag explains why rather than
 * leaving the reader to infer it from an absence.
 */
function ThisMachineTag(): ReactNode {
  return (
    <span className="shrink-0 text-[0.625rem] text-muted-foreground/60">
      this machine
    </span>
  );
}
