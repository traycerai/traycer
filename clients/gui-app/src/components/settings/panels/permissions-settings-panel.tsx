/**
 * Docs: see ../SETTINGS.md (Permissions).
 * Update that file whenever this settings surface changes.
 */
import { useLayoutEffect, useState, type ReactNode } from "react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  PERMISSIONS_TABS,
  PERMISSIONS_TAB_GROUPS,
  isPermissionsTab,
  permissionsTabForAnchor,
  type PermissionsTab,
} from "@/components/settings/panels/permissions-settings.definitions";
import { ModesTab } from "@/components/settings/panels/permissions/modes-tab";
import { JudgeTab } from "@/components/settings/panels/permissions/judge-tab";
import { RulesTab } from "@/components/settings/panels/permissions/rules-tab";
import { ActivityTab } from "@/components/settings/panels/permissions/activity-tab";
import { useRulesEdit } from "@/components/settings/panels/permissions/rules-edit-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import {
  acknowledgeSettingsOpenIntent,
  useSettingsOpenIntent,
} from "@/stores/tabs/settings-open-intent-store";

/**
 * Settings ▸ Permissions: which mode, who reviews, what rules, what happened -
 * one tab per question, in that order.
 *
 * The page sits in the sidebar's Host group because three of its four tabs are
 * per machine: the judge is stored on the host, the rules are read through it,
 * and the log is the host's own. `HostScopeGate` therefore wraps those three
 * tab BODIES, never the page. Modes is the one app-scoped region - the default
 * mode is one preference for this app - so it renders with no host in scope,
 * and the tab bar above everything is never gated, which is what lets each
 * tab's trigger carry a settings-search anchor.
 *
 * The open intent selects a tab, hands a prepared rule to Rules, and names the
 * machine the caller had in mind; that machine becomes the Settings scope
 * BEFORE the tab's body mounts, so a composer's "Permission settings…" always
 * lands on its own machine's judge.
 *
 * The Rules edit lives with this window's Settings, not with the page
 * (`rules-edit-store.ts`), keyed by the signed-in account alone. The policy is
 * the account's - traycer-server stores it and every machine reads the same
 * one - so a switch of machine re-keys the editor under `HostScopeGate` but
 * must not lose an unsaved edit: the remounted editor resumes from the stored
 * copy and re-takes its opening read on the machine now showing. Leaving
 * Permissions for another section, the modal's remount when theme editing
 * releases it, a promotion to the Settings tab, and that tab's eviction all
 * replace this page, and none of them touches the edit. Only a switch of
 * account, Discard, or closing Settings drops it.
 */
export function PermissionsSettingsPanel(): ReactNode {
  const scope = useHostScope();
  const isMobile = useIsMobileViewport();
  const intent = useSettingsOpenIntent("permissions");
  const pendingReveal = useSettingsSearchStore((state) => state.pendingReveal);
  const [tab, setTab] = useState<PermissionsTab>("modes");
  const [rulesVisited, setRulesVisited] = useState(false);
  const [appliedIntentId, setAppliedIntentId] = useState<number | null>(null);
  const [appliedRevealAt, setAppliedRevealAt] = useState<number | null>(null);
  const rules = useRulesEdit();
  const { enqueueDraft, enqueueIntentDraft } = rules;

  // The intent, applied once per arm during render so the requested tab is the
  // first one drawn. A draft always means Rules, whatever else was asked; the
  // draft itself is queued below, with the acknowledgement.
  if (intent !== null && intent.id !== appliedIntentId) {
    setAppliedIntentId(intent.id);
    if (intent.draft !== null) {
      setTab("rules");
    } else if (isPermissionsTab(intent.tab)) {
      setTab(intent.tab);
    }
  }
  // A settings-search landing on a tab trigger, or on the Modes row, opens
  // that tab. Keyed by the request's time, so clicking one result twice (a
  // second request for the same anchor) opens it again.
  if (
    pendingReveal !== null &&
    pendingReveal.section === "permissions" &&
    pendingReveal.requestedAt !== appliedRevealAt
  ) {
    setAppliedRevealAt(pendingReveal.requestedAt);
    const revealTab = permissionsTabForAnchor(pendingReveal.anchor);
    if (revealTab !== null) setTab(revealTab);
  }
  // Rules starts its read when it mounts, so it mounts on its first visit -
  // a draft handed to it is one - and stays mounted from then on.
  if (tab === "rules" && !rulesVisited) setRulesVisited(true);
  // The intent's machine becomes the Settings scope before paint, its draft is
  // queued, and the intent is spent. The draft goes to the Rules edit, a store
  // this page does not own, so it is queued here rather than during render (a
  // render may only adjust its own component's state), and before paint.
  // LAYOUT, so the host-scoped bodies below never paint a frame of the
  // previous machine.
  useLayoutEffect(() => {
    if (intent === null) return;
    carryViewedHostIntoSettingsScope(intent.hostId);
    if (intent.draft !== null) enqueueIntentDraft(intent.id, intent.draft);
    acknowledgeSettingsOpenIntent(intent.id);
  }, [intent, enqueueIntentDraft]);
  // Until then the gated bodies hold, so none of them mounts - and starts a
  // read - against the machine the page is about to leave. Compared with the
  // machine the scope RESOLVES to, not the pin: an intent naming the machine
  // Settings already follows moves nothing, and holding would unmount every
  // body for a frame.
  const scopePending =
    intent !== null && intent.hostId !== null && intent.hostId !== scope.hostId;

  const gated = (body: ReactNode): ReactNode =>
    scopePending ? null : (
      <PermissionsHostGate scope={scope}>{body}</PermissionsHostGate>
    );
  const contentLabel = (value: PermissionsTab) =>
    isMobile
      ? {
          "aria-labelledby": undefined,
          "aria-label": PERMISSIONS_TAB_GROUPS[value].label,
        }
      : {};

  return (
    <SettingsPanelShell
      title="Permissions"
      description="How much an agent may do on its own, and who reviews the rest."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (isPermissionsTab(next)) setTab(next);
        }}
        className="gap-0"
      >
        {isMobile ? (
          <PermissionsTabSelect tab={tab} onSelect={setTab} />
        ) : (
          <TabsList
            variant="line"
            className="h-auto w-full max-w-full shrink-0 flex-wrap justify-start"
          >
            {PERMISSIONS_TABS.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="flex-none"
                data-settings-anchor={
                  PERMISSIONS_TAB_GROUPS[value].anchor ?? undefined
                }
                data-testid={`permissions-tab-${value}`}
              >
                {PERMISSIONS_TAB_GROUPS[value].label}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <TabsContent value="modes" className="pt-5" {...contentLabel("modes")}>
          <ModesTab />
        </TabsContent>
        <TabsContent value="judge" className="pt-5" {...contentLabel("judge")}>
          {gated(<JudgeTab />)}
        </TabsContent>
        {/* Mounted while hidden once visited, so a save in flight - whose
            answer re-seeds the editor - survives a look at another tab; the
            edit itself lives with Settings (`rules-edit-store.ts`). Never
            before the first visit, so opening on another tab starts no Rules
            read. Radix leaves a force-mounted pane visible, hence the class. */}
        <TabsContent
          value="rules"
          forceMount={rulesVisited ? true : undefined}
          className="pt-5 data-[state=inactive]:hidden"
          {...contentLabel("rules")}
        >
          {gated(
            <RulesTab
              active={tab === "rules"}
              drafts={rules.edit.drafts}
              onDraftsConsumed={rules.onDraftsConsumed}
              snapshot={rules.edit.snapshot}
              onSnapshot={rules.onSnapshot}
            />,
          )}
        </TabsContent>
        <TabsContent
          value="activity"
          className="pt-5"
          {...contentLabel("activity")}
        >
          {gated(
            <ActivityTab
              onAllowFromNowOn={(draft) => {
                setTab("rules");
                enqueueDraft(draft);
              }}
              onFixInJudge={() => setTab("judge")}
            />,
          )}
        </TabsContent>
      </Tabs>
    </SettingsPanelShell>
  );
}

function PermissionsHostGate(props: {
  readonly scope: HostScope;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <HostScopeGate
      scope={props.scope}
      skeleton={<HostScopeConnecting hostName={props.scope.hostLabel} />}
    >
      {props.children}
    </HostScopeGate>
  );
}

/**
 * The phone presentation of the tab bar: one dropdown naming the active tab,
 * as the Providers panel does, because a wrapped line bar is two ragged rows
 * of chrome on a phone. Its trigger carries the ACTIVE tab's search anchor -
 * the tab triggers do not exist here, and a search landing switches the tab
 * before it looks for the anchor, so the one it asks for is always the one
 * this trigger carries.
 */
function PermissionsTabSelect(props: {
  readonly tab: PermissionsTab;
  readonly onSelect: (tab: PermissionsTab) => void;
}): ReactNode {
  return (
    <Select
      value={props.tab}
      onValueChange={(value) => {
        if (isPermissionsTab(value)) props.onSelect(value);
      }}
    >
      <SelectTrigger
        aria-label="Section"
        className="w-full shrink-0"
        data-settings-anchor={
          PERMISSIONS_TAB_GROUPS[props.tab].anchor ?? undefined
        }
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PERMISSIONS_TABS.map((value) => (
          <SelectItem key={value} value={value}>
            {PERMISSIONS_TAB_GROUPS[value].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
