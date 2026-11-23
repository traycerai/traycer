import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { MEMBERS } from "@/components/settings/environment/members-page.definitions";
import { SANDBOXES } from "@/components/settings/environment/sandboxes-page.definitions";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import {
  HostScopeConnecting,
  HostScopeNotice,
  UnreachableNotice,
} from "@/components/settings/host-scope/host-scope-gate";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  usePersonalHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { isLocalMovePageSection } from "@/components/settings/environment/local-move-sections";
import { HostUpdateNowAction } from "@/components/settings/panels/host-update-now-action";
import { AGENT_MEMORIES } from "@/components/settings/panels/agent-memories.definitions";
import { MCP_SERVERS } from "@/components/settings/panels/mcp-servers.definitions";
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

/** The pages a picked computer can lack, each with its own heading. */
const PAGE_COPY: ReadonlyMap<SettingsSectionId, PageCopy> = new Map<
  SettingsSectionId,
  PageCopy
>([
  ["mcp-servers", MCP_SERVERS.page],
  ["skills", SKILLS.page],
  ["agent-memories", AGENT_MEMORIES.page],
  ["secrets", SECRETS.page],
  ["sandboxes", SANDBOXES.page],
  ["storage", STORAGE.page],
  ["members", MEMBERS.page],
]);

/** What a section's body shows in place of the page, keyed by its answer. */
type PageNotOnComputerAnswer =
  | Exclude<SectionAnswer, { readonly kind: "served" | "unresolved" }>
  | { readonly kind: "away"; readonly host: HostScopeOption };

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
  const { pick } = props;
  const scope = usePersonalHostScope();
  const answer = notOnComputerAnswer(
    props.section,
    useSectionAnswer(pick, props.section),
    pick.kind === "local",
    scope,
  );
  return answer === null ? (
    props.children
  ) : (
    <PageNotOnComputer section={props.section} answer={answer} scope={scope} />
  );
}

/**
 * What replaces the page, or `null` for the page itself. A Local pick of a
 * computer that cannot be reached shows the scope's notice wherever the page
 * would otherwise not draw, or offer a move it cannot run: that outranks the
 * computer lacking the page, since nothing on it can be updated until it is
 * back. A page that draws keeps its own gate, which holds its drafts.
 */
function notOnComputerAnswer(
  section: SettingsSectionId,
  answer: SectionAnswer,
  local: boolean,
  scope: HostScope,
): PageNotOnComputerAnswer | null {
  const drawn = answer.kind === "served" || answer.kind === "unresolved";
  if (
    local &&
    scope.status === "unreachable" &&
    scope.host !== null &&
    (!drawn || isLocalMovePageSection(section))
  ) {
    return { kind: "away", host: scope.host };
  }
  return drawn ? null : answer;
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
  const entry = SETTINGS_SECTIONS.find((item) => item.id === props.section);
  const copy = PAGE_COPY.get(props.section);
  const label = copy?.label ?? entry?.label ?? "";
  return (
    <SettingsPanelShell title={label} description={copy?.description}>
      <div className="p-5" data-testid="page-not-on-computer">
        <PageNotOnComputerCard
          answer={props.answer}
          label={label}
          icon={entry?.icon ?? null}
          scope={props.scope}
        />
      </div>
    </SettingsPanelShell>
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
    case "away":
      // The scope's own notice: nothing on the computer can be read or
      // updated until it is back.
      return <UnreachableNotice scope={props.scope} host={answer.host} />;
    case "update":
      return (
        <HostScopeNotice
          icon={props.icon}
          tone="idle"
          title={`Not on ${answer.hostName}`}
          detail={`Update ${answer.hostName} to use ${props.label}.`}
          action={<HostUpdateNowAction hostId={answer.hostId} />}
          testId="page-not-on-computer-update"
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
