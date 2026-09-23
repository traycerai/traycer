/**
 * Docs: see ../SETTINGS.md (Permissions).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useLayoutEffect, useState, type ReactNode } from "react";
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
import type { PendingRuleDraft } from "@/components/settings/panels/auto-policy-document";
import { ModesTab } from "@/components/settings/panels/permissions/modes-tab";
import { JudgeTab } from "@/components/settings/panels/permissions/judge-tab";
import { RulesTab } from "@/components/settings/panels/permissions/rules-tab";
import { ActivityTab } from "@/components/settings/panels/permissions/activity-tab";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  acknowledgeSettingsOpenIntent,
  useSettingsOpenIntent,
} from "@/stores/tabs/settings-open-intent-store";
import type { SettingsRuleDraft } from "@/stores/tabs/system-overlay-types";

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
 */
export function PermissionsSettingsPanel(): ReactNode {
  const scope = useHostScope();
  const isMobile = useIsMobileViewport();
  const intent = useSettingsOpenIntent("permissions");
  const pendingReveal = useSettingsSearchStore((state) => state.pendingReveal);
  const scopedHostId = useSettingsHostScopeStore((state) => state.scopedHostId);
  const [tab, setTab] = useState<PermissionsTab>("modes");
  const [appliedIntentId, setAppliedIntentId] = useState<number | null>(null);
  const [appliedRevealAt, setAppliedRevealAt] = useState<number | null>(null);
  const [draftQueue, setDraftQueue] = useState<{
    readonly nextId: number;
    readonly drafts: ReadonlyArray<PendingRuleDraft>;
  }>({ nextId: 1, drafts: [] });

  const enqueueDraft = useCallback((draft: SettingsRuleDraft): void => {
    setDraftQueue((queue) => ({
      nextId: queue.nextId + 1,
      drafts: [...queue.drafts, { id: queue.nextId, draft }],
    }));
  }, []);
  const onDraftsConsumed = useCallback((throughId: number): void => {
    setDraftQueue((queue) =>
      queue.drafts.every((entry) => entry.id > throughId)
        ? queue
        : {
            ...queue,
            drafts: queue.drafts.filter((entry) => entry.id > throughId),
          },
    );
  }, []);

  // The intent, applied once per arm during render so the requested tab is the
  // first one drawn. A draft always means Rules, whatever else was asked.
  if (intent !== null && intent.id !== appliedIntentId) {
    setAppliedIntentId(intent.id);
    if (intent.draft !== null) {
      setTab("rules");
      enqueueDraft(intent.draft);
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
  // The intent's machine becomes the Settings scope before paint, and the
  // intent is spent. A store write, so it belongs in an effect; LAYOUT, so the
  // host-scoped bodies below never paint a frame of the previous machine.
  useLayoutEffect(() => {
    if (intent === null) return;
    carryViewedHostIntoSettingsScope(intent.hostId);
    acknowledgeSettingsOpenIntent(intent.id);
  }, [intent]);
  // Until then the gated bodies hold, so none of them mounts - and starts a
  // read - against the machine the page is about to leave.
  const scopePending =
    intent !== null && intent.hostId !== null && intent.hostId !== scopedHostId;

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
        {/* Mounted while hidden, so an unsaved edit - a draft the card or the
            Activity tab handed over included - survives a look at another
            tab. Radix leaves a force-mounted pane visible, hence the class. */}
        <TabsContent
          value="rules"
          forceMount
          className="pt-5 data-[state=inactive]:hidden"
          {...contentLabel("rules")}
        >
          {gated(
            <RulesTab
              active={tab === "rules"}
              drafts={draftQueue.drafts}
              onDraftsConsumed={onDraftsConsumed}
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
