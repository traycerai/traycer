import { Fragment, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_GROUPS,
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
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { AddHostDialog } from "@/components/settings/host-scope/add-host-dialog";

export type SettingsSidebarMode =
  | { readonly kind: "route" }
  | {
      readonly kind: "modal";
      readonly activeSection: SettingsSectionId;
      readonly onSelect: (section: SettingsSectionId) => void;
    };

/**
 * "rail" is the desktop two-pane nav column; "mobile-list" is the same
 * sections rendered as a full-width drill-down list (the `/settings` index on
 * phones).
 */
export type SettingsSidebarVariant = "rail" | "mobile-list";

export interface SettingsSidebarProps {
  readonly mode: SettingsSidebarMode;
  readonly variant: SettingsSidebarVariant;
}

/**
 * The sidebar carries the scope model.
 *
 * Application and Account come first — short, fixed, never re-shaped — and the
 * host group goes last, headed by ONE picker with its scoped sections beneath.
 * The picker is deliberately NOT a level of navigation: Providers already
 * spends the app's nesting budget on a rail plus a tab bar, so a host tier
 * here would have made the deepest page four levels down. See
 * `settings-sections.ts` for the grouping itself.
 */
export function SettingsSidebar(props: SettingsSidebarProps) {
  const scope = useHostScope();
  // A section backed by the local config store cannot describe a host this
  // window can only reach over the wire. Dimming those rows while a remote
  // host is selected costs a click that would only ever land on a notice.
  //
  // An unresolved scope is NOT local. Treating `null` as local lit those rows
  // up as fully available while the panels behind them had no host to describe
  // — the rail promising what the page could not deliver.
  const localHostSelected = scope.host !== null && scope.host.isLocalMachine;
  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col gap-1 overflow-y-auto bg-background p-4",
        props.variant === "rail"
          ? "w-[clamp(13rem,20vw,17rem)] border-r border-border/60"
          : "w-full",
      )}
    >
      {SETTINGS_SECTION_GROUPS.map((group, groupIndex) => (
        <Fragment key={group.id}>
          {groupIndex === 0 ? null : <SettingsSidebarGroupRule />}
          <SettingsSidebarGroupHeader label={group.label} />
          {group.id === "host" ? (
            <SettingsSidebarHostPicker scope={scope} />
          ) : null}
          <div
            className={cn(
              "flex flex-col gap-0.5",
              // Indent alone: these sections are not siblings of the host row,
              // they are its contents, and stepping them in says so without
              // drawing anything. A guide line said the same thing louder and
              // put a second vertical edge next to the rail's own border.
              group.id === "host" && "ml-4",
            )}
          >
            {SETTINGS_SECTIONS.map((section, index) =>
              section.group === group.id ? (
                <SettingsSidebarItem
                  key={section.id}
                  section={section}
                  index={index}
                  mode={props.mode}
                  variant={props.variant}
                  unreachable={
                    section.requiresLocalHost ? !localHostSelected : false
                  }
                />
              ) : null,
            )}
          </div>
        </Fragment>
      ))}
    </aside>
  );
}

/**
 * The scope control, between the "Host" heading and the sections it governs —
 * the one position that reads as "everything below belongs to this".
 */
function SettingsSidebarHostPicker(props: {
  // Resolved once by the sidebar above — the composition behind `useHostScope`
  // is six hooks deep, and this component would run all of it a second time
  // in the same render pass.
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const openAddHost = useAddHostDialogStore((s) => s.openDialog);
  // `gap-0.5` matches the section rows below, so the picker reads as the first
  // row of the tier it heads rather than a control docked above it.
  return (
    <div className="flex flex-col gap-0.5">
      <HostSwitcher
        hosts={scope.hosts}
        selected={scope.host}
        activeHostId={scope.activeHostId}
        onSelect={scope.setHostId}
        onAddHost={() => openAddHost(scope.hosts.map((host) => host.hostId))}
        isLoading={scope.isLoading}
        listsFailed={scope.listsFailed}
        onRetryLists={scope.retryLists}
      />
      {/* Said at rest, not on discovery: sections describing a host that is
          NOT the one this window runs on is the single most confusing state
          this surface can be in, so it never waits to be noticed. */}
      {scope.host === null || scope.isViewingActive ? null : (
        <p
          className="px-1 text-[0.6875rem] leading-snug text-muted-foreground/80"
          data-testid="settings-host-viewing-note"
        >
          Viewing — this window runs on{" "}
          {scope.activeHost?.name ?? "another host"}.
        </p>
      )}
      {/* Mounted once: the picker footer is the only opener, but the dialog
          reads a shared store and two copies would race its open state. */}
      <AddHostDialog />
    </div>
  );
}

/**
 * Whether `pathname` is this section's route, matching on whole path segments
 * rather than by prefix, so no section id can ever light up another's row.
 */
function isSectionPathname(
  pathname: string,
  sectionId: SettingsSectionId,
): boolean {
  const base = `/settings/${sectionId}`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * The tier boundary, drawn edge to edge.
 *
 * It bleeds past the rail's padding (`-mx-4`) so it reads as a division OF the
 * rail rather than a box drawn inside it — which is also why the host picker
 * below carries no border of its own: one of them has to be the boundary, and
 * a rule costs nothing to scan past.
 */
function SettingsSidebarGroupRule(): ReactNode {
  return <div aria-hidden className="-mx-4 my-3 border-t border-border/60" />;
}

function SettingsSidebarGroupHeader(props: {
  readonly label: string;
}): ReactNode {
  return (
    <h2 className="mb-1 px-3 font-semibold text-ui-xs tracking-wide text-muted-foreground/70 uppercase">
      {props.label}
    </h2>
  );
}

interface SettingsSidebarItemProps {
  section: SettingsSection;
  index: number;
  mode: SettingsSidebarMode;
  variant: SettingsSidebarVariant;
  unreachable: boolean;
}

function SettingsSidebarItem(props: SettingsSidebarItemProps) {
  const { section, index, mode, variant, unreachable } = props;
  const badgeModifier = useSettingsLeaderModifierForIndex(index);
  const Icon = section.icon;
  const digit = singleDigitLeaderDigitFor(index);
  const baseClass = cn(
    "inline-flex items-center gap-3 rounded-md px-3 text-ui-sm transition-colors",
    variant === "mobile-list" ? "py-3" : "py-2",
  );
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
    <span className="min-w-0 flex-1 truncate">{section.label}</span>
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
          unreachable && !active && "text-foreground/40",
        )}
      >
        <Icon className="size-4 shrink-0" />
        {label}
        {badge}
      </button>
    );
  }
  return (
    <SettingsSidebarRouteItem
      section={section}
      label={label}
      badge={badge}
      baseClass={baseClass}
      variant={variant}
      unreachable={unreachable}
    />
  );
}

function SettingsSidebarRouteItem(props: {
  readonly section: SettingsSection;
  readonly label: ReactNode;
  readonly badge: ReactNode;
  readonly baseClass: string;
  readonly variant: SettingsSidebarVariant;
  readonly unreachable: boolean;
}) {
  const { section, label, badge, baseClass, variant, unreachable } = props;
  const Icon = section.icon;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = isSectionPathname(pathname, section.id);
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
        baseClass,
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground",
        unreachable && !active && "text-foreground/40",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {label}
      {badge}
      {variant === "mobile-list" ? (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
      ) : null}
    </Link>
  );
}
