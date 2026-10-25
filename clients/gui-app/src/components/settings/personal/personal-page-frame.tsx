import { useContext, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentNotice,
  EnvironmentReviewEntry,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import {
  NO_NOTICES,
  NO_OVERRIDES,
  NO_REVIEW,
  PersonalPageContext,
} from "@/components/settings/personal/personal-page-context";
import { PersonalPageNotices } from "@/components/settings/personal/personal-page-notices";
import { PageChip } from "@/components/settings/personal/page-chip";
import { SecretsHeaderDetails } from "@/components/settings/secrets/secrets-header-details";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { TeamOwnedLine } from "@/components/settings/host-scope/team-owned-line";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  personalPageItemKinds,
  personalPageStatusLine,
  type PersonalHostState,
  type PersonalPageStatusLine,
} from "@/components/settings/personal/personal-page-status";
import {
  useEnvironmentLocalOverridesRead,
  useEnvironmentNoticesRead,
  useEnvironmentReviewRead,
  useEnvironmentStatusRead,
} from "@/hooks/environment/use-environment-reads";
import { useRereadConfigurationOnFocus } from "@/hooks/environment/use-reread-configuration-on-focus";
import { useRereadHostReadsOnFocus } from "@/hooks/environment/use-reread-host-reads-on-focus";
import { useRereadOnStaleWrite } from "@/hooks/environment/use-reread-on-stale-write";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import type { HostRpcRegistry } from "@/lib/host";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import {
  ConfigurationSourceBoundary,
  type CloudConfigurationTarget,
} from "@/components/settings/environment/configuration-source-boundary";
import { hostRunsPersonal } from "@/components/settings/environment/environment-picker-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { cn } from "@/lib/utils";

interface WindowHostEnvironment {
  readonly state: PersonalHostState;
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
  readonly localOverrides: readonly LocalOverride[];
  readonly notices: readonly EnvironmentNotice[];
  readonly review: readonly EnvironmentReviewEntry[];
}

/** Read through the window's own host, like every Personal page. */
function useWindowHostEnvironmentState(
  kinds: ReadonlySet<string>,
): WindowHostEnvironment {
  const scope = usePersonalHostScope();
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const overrides = useEnvironmentLocalOverridesRead(
    scope.client,
    scope.hostId,
    true,
  );
  let state: PersonalHostState = { kind: "unknown" };
  if (status.supported === false) state = { kind: "unsupported" };
  else if (status.data !== null) {
    state =
      status.data.principal === null
        ? { kind: "not-set-up" }
        : { kind: "ready", status: status.data };
  }
  // Notices and "needs you" rows are the person's own settings' facts: none
  // on a host without them, or on a team's host.
  const personal =
    state.kind === "ready" && state.status.principal?.kind === "personal";
  const notices = useEnvironmentNoticesRead(
    scope.client,
    scope.hostId,
    personal,
  );
  const review = useEnvironmentReviewRead(scope.client, scope.hostId, personal);
  return {
    state,
    hostId: scope.hostId,
    client: scope.client,
    hostName: scope.hostLabel,
    localOverrides: overrides.data?.overrides ?? NO_OVERRIDES,
    notices: personal
      ? ofKinds(notices.data?.notices ?? NO_NOTICES, kinds)
      : NO_NOTICES,
    review: personal
      ? ofKinds(review.data?.entries ?? NO_REVIEW, kinds)
      : NO_REVIEW,
  };
}

function ofKinds<Entry extends { readonly kind: string }>(
  entries: readonly Entry[],
  kinds: ReadonlySet<string>,
): readonly Entry[] {
  return entries.some((entry) => !kinds.has(entry.kind))
    ? entries.filter((entry) => kinds.has(entry.kind))
    : entries;
}

/** The team a host's settings belong to, or `null` for the person's own. */
function teamNameOf(state: PersonalHostState): string | null {
  if (state.kind !== "ready") return null;
  const { principal } = state.status;
  return principal?.kind === "team" ? principal.teamName : null;
}

/**
 * Wraps a Personal page: its status line (rendered by `SettingsPanelShell`
 * under the page's description) and, on a host whose version predates these
 * settings, the read-only rendering the flows give it: the page shows the
 * host's own values and takes no edits until the host is updated.
 *
 * Which source an Environment page reads is decided here, one rule per pick:
 * a team reads the cloud; a Local row reads that computer's own pages;
 * Personal reads the cloud unless the window's host runs Personal
 * (`hostRunsPersonal`, the dropdown's own rule), when that host's pages stay;
 * MCP servers and Skills read the cloud on Personal always.
 *
 * Mounted once per page by `SettingsPanelForSection`, which both settings
 * surfaces render through, so neither can show a Personal page without it.
 */
export function PersonalPageFrame(props: {
  readonly section: SettingsSectionId;
  readonly children: ReactNode;
}): ReactNode {
  const pick = useEnvironmentPick();
  const environmentPage = SETTINGS_SECTIONS.some(
    (section) => section.id === props.section && section.group === "personal",
  );
  if (pick.kind === "team" && environmentPage) {
    return (
      <CloudPageFrame
        key={pick.environmentId}
        section={props.section}
        pick={pick}
        target={{ kind: "team", environmentId: pick.environmentId }}
      >
        {props.children}
      </CloudPageFrame>
    );
  }
  if (pick.kind === "personal" && CLOUD_ONLY_SECTIONS.has(props.section)) {
    return (
      <CloudPageFrame
        section={props.section}
        pick={pick}
        target={{ kind: "personal" }}
      >
        {props.children}
      </CloudPageFrame>
    );
  }
  if (pick.kind === "personal" && environmentPage) {
    return (
      <PersonalSourceFrame section={props.section} pick={pick}>
        {props.children}
      </PersonalSourceFrame>
    );
  }
  return (
    <HostPageFrame section={props.section}>{props.children}</HostPageFrame>
  );
}

/**
 * Pages Personal reads from the cloud even when the window's host runs it:
 * no host serves an environment-wide form of them, only each provider's own.
 */
const CLOUD_ONLY_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  "mcp-servers",
  "skills",
]);

/**
 * Personal from the cloud, or from the window's host when it runs Personal.
 * Nothing renders while that host's status is unknown: a guess would show
 * one source's values and then swap to the other's.
 */
function PersonalSourceFrame(props: {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
  readonly children: ReactNode;
}): ReactNode {
  const runs = useWindowHostRunsPersonal();
  if (runs === null) {
    return (
      <AgentSpinningDots
        className={undefined}
        testId="personal-source-loading"
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (runs) {
    return (
      <HostPageFrame section={props.section}>{props.children}</HostPageFrame>
    );
  }
  return (
    <CloudPageFrame
      section={props.section}
      pick={props.pick}
      target={{ kind: "personal" }}
    >
      {props.children}
    </CloudPageFrame>
  );
}

/**
 * Whether the window's host runs Personal; `null` while it is unknown: no
 * handshake yet, or a host that serves `environment.status` and has not
 * answered. A window with no host runs nothing, and neither does one whose
 * host cannot be reached: its pages read the cloud rather than wait for a
 * handshake that cannot happen.
 */
function useWindowHostRunsPersonal(): boolean | null {
  const scope = usePersonalHostScope();
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const version = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.status",
  );
  if (scope.hostId === null) return false;
  if (scope.status === "unreachable" || scope.status === "vanished")
    return false;
  if (version === null) return null;
  if (version !== false && status.data === null && !status.isError) {
    return null;
  }
  return hostRunsPersonal(
    { hostId: scope.hostId, name: scope.hostLabel },
    status.data,
    version,
  );
}

/** A page whose source is a host's own: Personal on its host, or a Local row. */
function HostPageFrame(props: {
  readonly section: SettingsSectionId;
  readonly children: ReactNode;
}): ReactNode {
  const pick = useEnvironmentPick();
  // A Local row's settings are its computer's own, and no status reports
  // their revision: they are reread on focus.
  useRereadHostReadsOnFocus(pick.kind === "local" ? pick.hostId : null);
  const kinds = personalPageItemKinds(props.section);
  if (
    kinds === null &&
    props.section !== "permissions" &&
    props.section !== "secrets" &&
    props.section !== "members"
  )
    return props.children;
  if (kinds === null)
    return (
      <PersonalPageContext.Provider
        value={{
          section: props.section,
          pick,
          state: { kind: "unknown" },
          line: null,
          hostName: "",
          hostId: null,
          client: null,
          localOverrides: NO_OVERRIDES,
          notices: NO_NOTICES,
          review: NO_REVIEW,
        }}
      >
        {props.children}
      </PersonalPageContext.Provider>
    );
  return (
    <PersonalPageFrameForKinds section={props.section} kinds={kinds}>
      {props.children}
    </PersonalPageFrameForKinds>
  );
}

/** A page read from the cloud, behind the configuration's boundary. */
function CloudPageFrame(props: {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
  readonly target: CloudConfigurationTarget;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ConfigurationSourceBoundary target={props.target}>
      <TeamPageFrame section={props.section} pick={props.pick}>
        {props.children}
      </TeamPageFrame>
    </ConfigurationSourceBoundary>
  );
}

/**
 * Cloud-read pages never read the window host's Personal notices or values.
 * Their configuration is reread when a save on the page loses to a newer
 * change, and when the window regains focus: no status reports a team's
 * revision, nor Personal's when the window's host does not run it. Where it
 * does, the host's revision rereads Personal too.
 */
function TeamPageFrame(props: {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
  readonly children: ReactNode;
}): ReactNode {
  const scope = useTeamViewingHost();
  const source = useConfigurationSource();
  const environmentId = source.kind === "pool" ? source.environmentId : null;
  useRereadOnStaleWrite(null, environmentId);
  useRereadConfigurationOnFocus(environmentId);
  return (
    <PersonalPageContext.Provider
      value={{
        section: props.section,
        pick: props.pick,
        state: { kind: "unknown" },
        line: null,
        hostName: scope.viewingHost?.hostLabel ?? "",
        hostId: scope.viewingHost?.hostId ?? null,
        client: scope.client,
        localOverrides: NO_OVERRIDES,
        notices: NO_NOTICES,
        review: NO_REVIEW,
      }}
    >
      {props.children}
    </PersonalPageContext.Provider>
  );
}

function PersonalPageFrameForKinds(props: {
  readonly section: SettingsSectionId;
  readonly kinds: ReadonlySet<string>;
  readonly children: ReactNode;
}): ReactNode {
  const pick = useEnvironmentPick();
  const environment = useWindowHostEnvironmentState(props.kinds);
  const { state, hostName } = environment;
  // A save on this page that lost to a change made elsewhere re-reads it.
  useRereadOnStaleWrite(environment.hostId, null);
  const line = personalPageStatusLine(state, props.kinds, hostName);
  // Read-only on a host whose version predates these settings, and on a
  // team's host, whose settings are the team's.
  const readOnly = state.kind === "unsupported" || teamNameOf(state) !== null;
  return (
    <PersonalPageContext.Provider
      value={{ ...environment, line, section: props.section, pick }}
    >
      {readOnly ? (
        <div className="contents">
          <PersonalPageReadOnlyLine />
          <div inert className="opacity-60">
            {props.children}
          </div>
        </div>
      ) : (
        props.children
      )}
    </PersonalPageContext.Provider>
  );
}

/**
 * The read-only page's note, outside the inert region so it stays readable
 * by assistive technology; the shell skips its own line in that state.
 */
function PersonalPageReadOnlyLine(): ReactNode {
  const value = useContext(PersonalPageContext);
  if (value === null) return null;
  const teamName = teamNameOf(value.state);
  let content: ReactNode = null;
  if (teamName !== null) content = <TeamOwnedLine teamName={teamName} />;
  else if (value.line !== null) {
    content = <PersonalPageStatusBanner line={value.line} />;
  }
  if (content === null) return null;
  return <div className="mx-auto w-full max-w-5xl px-5 pt-5">{content}</div>;
}

const TONE_CLASSES: Readonly<Record<PersonalPageStatusLine["tone"], string>> = {
  info: "border-info/30 bg-info/10 text-info-foreground",
  warning: "border-warning/30 bg-warning/10 text-warning-foreground",
};

function PersonalPageStatusBanner(props: {
  readonly line: PersonalPageStatusLine;
}): ReactNode {
  return (
    <p
      data-testid="personal-page-status"
      role="status"
      className={cn(
        "max-w-[72ch] rounded-md border px-3 py-1.5 text-ui-sm",
        TONE_CLASSES[props.line.tone],
      )}
    >
      {props.line.text}
    </p>
  );
}

/**
 * The status line inside a Personal page's header, for `SettingsPanelShell`.
 * Nothing outside a Personal page, and nothing on a read-only one, whose line
 * the frame draws above the inert page instead.
 */
export function PersonalPageHeaderStatus(): ReactNode {
  const value = useContext(PersonalPageContext);
  if (value === null) return null;
  if (value.pick.kind === "team")
    return <PageChipRow section={value.section} pick={value.pick} />;
  if (value.state.kind === "unsupported" || teamNameOf(value.state) !== null) {
    return null;
  }
  return (
    <>
      <PageChipRow section={value.section} pick={value.pick} />
      {value.line === null ? null : (
        <PersonalPageStatusBanner line={value.line} />
      )}
      <PersonalPageNotices />
    </>
  );
}

/** The page's chip, and on Secrets the page's own `Details` beside it. */
function PageChipRow(props: {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
}): ReactNode {
  if (props.section !== "secrets")
    return <PageChip section={props.section} pick={props.pick} />;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PageChip section={props.section} pick={props.pick} />
      <SecretsHeaderDetails />
    </div>
  );
}
