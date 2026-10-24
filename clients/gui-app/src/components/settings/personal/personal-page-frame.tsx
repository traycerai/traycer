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
import { useRereadOnStaleWrite } from "@/hooks/environment/use-reread-on-stale-write";
import type { HostRpcRegistry } from "@/lib/host";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
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
      <ConfigurationSourceBoundary
        key={pick.environmentId}
        environmentId={pick.environmentId}
      >
        <TeamPageFrame section={props.section} pick={pick}>
          {props.children}
        </TeamPageFrame>
      </ConfigurationSourceBoundary>
    );
  }
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

/** Team pages never read the window host's Personal notices or values. */
function TeamPageFrame(props: {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
  readonly children: ReactNode;
}): ReactNode {
  const scope = useTeamViewingHost();
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
  useRereadOnStaleWrite(environment.hostId);
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
  success: "border-success/30 bg-success/10 text-success-foreground",
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
    return <PageChip section={value.section} pick={value.pick} />;
  if (value.state.kind === "unsupported" || teamNameOf(value.state) !== null) {
    return null;
  }
  return (
    <>
      <PageChip section={value.section} pick={value.pick} />
      {value.line === null ? null : (
        <PersonalPageStatusBanner line={value.line} />
      )}
      <PersonalPageNotices />
    </>
  );
}
