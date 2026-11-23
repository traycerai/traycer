import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { MEMBERS } from "@/components/settings/environment/members-page.definitions";
import { SANDBOXES } from "@/components/settings/environment/sandboxes-page.definitions";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import {
  HostListsFailedNotice,
  HostScopeConnecting,
  HostScopeNotice,
  HostUnreachableGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  usePersonalHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { hostScopeNeedsUpdate } from "@/components/settings/host-scope/host-scope-status";
import { HostUpdateRequiredAction } from "@/components/settings/host-scope/host-update-required-action";
import { useHostUpdateNow } from "@/components/settings/panels/host-update-now-action";
import { AGENT_MEMORIES } from "@/components/settings/panels/agent-memories.definitions";
import { AGENT_SELECTION } from "@/components/settings/panels/agents-settings.definitions";
import { BROWSER_AGENT_ACCESS } from "@/components/settings/panels/browser-agent-access.definitions";
import { FALLBACK } from "@/components/settings/panels/fallback-settings.definitions";
import { MCP_SERVERS } from "@/components/settings/panels/mcp-servers.definitions";
import { PROVIDERS } from "@/components/settings/panels/providers-settings.definitions";
import { SHELL } from "@/components/settings/panels/shell-settings.definitions";
import { getClientAppVersion } from "@/lib/app-version";
import { hostAppVersionFromDirectoryEntry } from "@/lib/host/version-skew-copy";
import {
  hostUpdateActionApplies,
  olderHostUpdateVariant,
} from "@/lib/host/window-narration";
import { SECRETS } from "@/components/settings/panels/secrets.definitions";
import { SKILLS } from "@/components/settings/panels/skills.definitions";
import {
  useSectionAnswer,
  type SectionAnswer,
} from "@/components/settings/personal/use-old-host-local-pick";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import {
  isEnvironmentGroupSection,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

interface PageCopy {
  readonly label: string;
  readonly description: string;
}

/**
 * Each Environment page's own heading, for the body that stands in for it:
 * Connecting, the host lists' retry, the away notice, or a page the picked
 * computer lacks.
 */
const PAGE_COPY: ReadonlyMap<SettingsSectionId, PageCopy> = new Map<
  SettingsSectionId,
  PageCopy
>([
  ["providers", PROVIDERS.page],
  ["mcp-servers", MCP_SERVERS.page],
  ["skills", SKILLS.page],
  ["agent-memories", AGENT_MEMORIES.page],
  ["agents", AGENT_SELECTION.page],
  ["fallback", FALLBACK.page],
  ["shell", SHELL.page],
  ["browser-agent-access", BROWSER_AGENT_ACCESS.page],
  ["secrets", SECRETS.page],
  ["sandboxes", SANDBOXES.page],
  ["storage", STORAGE.page],
  ["members", MEMBERS.page],
]);

/** What a section's body shows in place of the page, keyed by its answer. */
type PageNotOnComputerAnswer = Exclude<
  SectionAnswer,
  { readonly kind: "served" | "unresolved" }
>;

/** `section`'s heading: its own page copy, else its rail label. */
function sectionHeading(section: SettingsSectionId): {
  readonly label: string;
  readonly description: string | undefined;
  readonly icon: LucideIcon | null;
} {
  const entry = SETTINGS_SECTIONS.find((item) => item.id === section);
  const copy = PAGE_COPY.get(section);
  return {
    label: copy?.label ?? entry?.label ?? "",
    description: copy?.description,
    icon: entry?.icon ?? null,
  };
}

/**
 * `section`'s body under the Environment pick: `children`, the page, or in
 * its place the answer for a page the picked computer does not serve. Only an
 * Environment section under Personal or a Local row reads a host: a team
 * reads the cloud, which serves every page, and an unresolved pick has its
 * own page; every other section is `children` as it is.
 */
export function PageOrNotOnComputer(props: {
  readonly section: SettingsSectionId;
  readonly children: ReactNode;
}): ReactNode {
  const pick = useEnvironmentPick();
  return isEnvironmentGroupSection(props.section) &&
    (pick.kind === "personal" || pick.kind === "local") ? (
    <HostPageOrNotOnComputer section={props.section} pick={pick}>
      {props.children}
    </HostPageOrNotOnComputer>
  ) : (
    props.children
  );
}

function HostPageOrNotOnComputer(props: {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
  readonly children: ReactNode;
}): ReactNode {
  const answer = useSectionAnswer(props.pick, props.section);
  const scope = usePersonalHostScope();
  const body =
    answer.kind === "served" || answer.kind === "unresolved" ? (
      props.children
    ) : (
      <PageNotOnComputer
        section={props.section}
        answer={answer}
        scope={scope}
      />
    );
  // A Local pick of a computer that cannot be reached shows the "Can't reach"
  // notice on every page, whatever the page or its answer, under the page's
  // own heading: nothing on it can be read or updated until it is back, and
  // the page stays mounted beneath.
  return props.pick.kind === "local" ? (
    <HostUnreachableGate
      scope={scope}
      renderNotice={(notice) => (
        <SectionStandIn section={props.section} testId="page-away">
          {notice}
        </SectionStandIn>
      )}
    >
      {body}
    </HostUnreachableGate>
  ) : (
    body
  );
}

/**
 * `section`'s heading over a body that stands in for its page while the page
 * cannot draw, so the heading on screen names the section the route does.
 */
export function SectionStandIn(props: {
  readonly section: SettingsSectionId;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  const heading = sectionHeading(props.section);
  return (
    <SettingsPanelShell title={heading.label} description={heading.description}>
      <div className="p-5" data-testid={props.testId}>
        {props.children}
      </div>
    </SettingsPanelShell>
  );
}

function SectionBody(props: {
  readonly section: SettingsSectionId;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <SectionStandIn section={props.section} testId="page-not-on-computer">
      {props.children}
    </SectionStandIn>
  );
}

/**
 * A section the picked computer does not serve, answered in its own body: the
 * section's heading, and a card saying so, with Update now where updating the
 * computer gives the page. The surface, the route and the rail stay where the
 * person is.
 */
function PageNotOnComputer(props: {
  readonly section: SettingsSectionId;
  readonly answer: PageNotOnComputerAnswer;
  readonly scope: HostScope;
}): ReactNode {
  const heading = sectionHeading(props.section);
  return (
    <SectionBody section={props.section}>
      <PageNotOnComputerCard
        answer={props.answer}
        label={heading.label}
        icon={heading.icon}
        scope={props.scope}
      />
    </SectionBody>
  );
}

function PageNotOnComputerCard(props: {
  readonly answer: PageNotOnComputerAnswer;
  readonly label: string;
  readonly icon: LucideIcon | null;
  readonly scope: HostScope;
}): ReactNode {
  const { answer } = props;
  switch (answer.kind) {
    case "pending":
      return <HostScopeConnecting hostName={answer.hostName} />;
    case "lists-failed":
      return <HostListsFailedNotice scope={props.scope} />;
    case "missing":
      return answer.updateGives ? (
        <PageNotOnComputerUpdate
          hostId={answer.hostId}
          hostName={answer.hostName}
          label={props.label}
          icon={props.icon}
          scope={props.scope}
        />
      ) : (
        <PageNotOnComputerNotice
          hostName={answer.hostName}
          icon={props.icon}
          detail={null}
          action={null}
        />
      );
    case "unlisted":
      return (
        <HostScopeNotice
          icon={props.icon}
          tone="idle"
          title={`Not on ${answer.hostName}`}
          detail={`${answer.hostName} isn't connected to this app.`}
          action={null}
          testId="page-not-on-computer-unlisted"
        />
      );
    case "team-only":
      return (
        <HostScopeNotice
          icon={props.icon}
          tone="idle"
          title="Only a team has members"
          detail={null}
          action={null}
          testId="page-not-on-computer-team-only"
        />
      );
  }
}

/** "Not on {computer}", with a line and an action only where they apply. */
function PageNotOnComputerNotice(props: {
  readonly hostName: string;
  readonly icon: LucideIcon | null;
  readonly detail: string | null;
  readonly action: ReactNode;
}): ReactNode {
  return (
    <HostScopeNotice
      icon={props.icon}
      tone="idle"
      title={`Not on ${props.hostName}`}
      detail={props.detail}
      action={props.action}
      testId={
        props.detail === null
          ? "page-not-on-computer-missing"
          : "page-not-on-computer-update"
      }
    />
  );
}

interface UpdateCardProps {
  readonly hostId: string;
  readonly hostName: string;
  readonly label: string;
  readonly icon: LucideIcon | null;
  readonly scope: HostScope;
}

/**
 * A page an update gives: "Update {computer} to use {page}." and its action,
 * both only where an update can be made. A computer below the minimum version
 * has no client to read its versions through, so it takes the update the
 * minimum-version notice offers; any other reads Host Overview's.
 */
function PageNotOnComputerUpdate(props: UpdateCardProps): ReactNode {
  return hostScopeNeedsUpdate(props.scope.host) && props.scope.host !== null ? (
    <BelowMinimumUpdate {...props} host={props.scope.host} />
  ) : (
    <LatestVersionUpdate {...props} />
  );
}

function BelowMinimumUpdate(
  props: UpdateCardProps & { readonly host: HostScopeOption },
): ReactNode {
  const detail = olderHostUpdateVariant(
    props.host.hostId,
    props.host.isActive,
    hostAppVersionFromDirectoryEntry(props.host.entry),
  ).detail;
  const applies = hostUpdateActionApplies(detail, getClientAppVersion());
  return (
    <PageNotOnComputerNotice
      hostName={props.hostName}
      icon={props.icon}
      detail={
        applies ? `Update ${props.hostName} to use ${props.label}.` : null
      }
      action={
        applies ? (
          <HostUpdateRequiredAction
            hostId={props.host.hostId}
            detail={detail}
            testId="page-not-on-computer-update-required"
          />
        ) : null
      }
    />
  );
}

function LatestVersionUpdate(props: UpdateCardProps): ReactNode {
  const update = useHostUpdateNow(props.hostId);
  return (
    <PageNotOnComputerNotice
      hostName={props.hostName}
      icon={props.icon}
      detail={
        update.applies
          ? `Update ${props.hostName} to use ${props.label}.`
          : null
      }
      action={update.applies ? update.action : null}
    />
  );
}
