import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EnvironmentInvitation } from "@traycer/protocol/host/environment/contracts";
import {
  ConfigurationSourceContext,
  configurationRoleOf,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { viewerCanSeeLine } from "@/components/settings/members/copy";
import { InviteAcceptDialog } from "@/components/settings/members/invite-accept-dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentInvitationsQuery } from "@/hooks/environment/use-environment-invitations";
import { useHostClient } from "@/lib/host";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { TeamReadFailed } from "./team-read-failed";
import { useConfigurationRevision } from "@/hooks/environment/use-configuration-revision";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

/** The team is gone from the person's memberships: they were removed from it. */
function noLongerInLine(teamName: string): string {
  return `You're no longer in ${teamName}.`;
}

/** The team invited them instead, so its settings are an Accept away. */
function invitedInsteadLine(teamName: string): string {
  return `You're invited to ${teamName}. Accept to see and change its settings.`;
}

/**
 * A configuration this window cannot name: a pick made on another computer, or
 * Personal's own id gone from the list. Nothing is claimed about a removal
 * from a team the app never saw the person in.
 */
const CONFIGURATION_UNAVAILABLE = "These settings are no longer available.";

/** The configuration a cloud-read page shows: a team's, or Personal. */
export type CloudConfigurationTarget =
  | { readonly kind: "team"; readonly environmentId: string }
  | { readonly kind: "personal" };

/**
 * Pages read `target` from the cloud. Nothing mounts with the host source
 * while its descriptor loads, so a team or Personal page never falls through
 * to the window host's own values.
 *
 * The boundary is also the one place that knows the picked configuration is
 * gone — a removal takes the team out of `environment.list` — and the one
 * place every cloud-read page passes through, so the removal line, the
 * invitation line and a viewer's standing line are said here once rather than
 * on each page.
 */
export function ConfigurationSourceBoundary(props: {
  readonly target: CloudConfigurationTarget;
  readonly children: ReactNode;
}): ReactNode {
  const { target } = props;
  const viewerId = useCloudChatViewerId();
  const client = useHostClient();
  const list = useEnvironmentListQuery(client, true);
  const descriptor = list.data?.environments.find((entry) =>
    target.kind === "team"
      ? entry.environmentId === target.environmentId &&
        entry.ownerKind === "organization"
      : entry.ownerKind === "user",
  );
  const source = useMemo<ConfigurationSource>(() => {
    if (descriptor === undefined) return { kind: "host" };
    return {
      kind: "pool",
      configuration: descriptor.ownerKind === "user" ? "personal" : "team",
      environmentId: descriptor.environmentId,
      roomId: descriptor.roomId,
      providerHandle: descriptor.providerHandle,
      effectiveRole: configurationRoleOf(descriptor),
    };
  }, [descriptor]);
  useConfigurationRevision(client, descriptor?.environmentId ?? null);
  const gone = useGoneConfiguration({
    target,
    listed:
      target.kind === "team" && descriptor !== undefined
        ? descriptor.label
        : null,
    settled: !list.isPending && !list.isError,
  });

  if (descriptor === undefined) {
    if (list.isPending) {
      return (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      );
    }
    if (list.isError) {
      return (
        <div className="p-5">
          <TeamReadFailed
            message="Couldn't read these settings."
            onRetry={() => void list.refetch()}
          />
        </div>
      );
    }
    if (gone.invitation !== null) {
      return (
        <div className="p-5">
          <InvitedInstead invitation={gone.invitation} />
        </div>
      );
    }
    return (
      <div className="p-5">
        <p role="status" className="text-ui-sm text-muted-foreground">
          {gone.name === null
            ? CONFIGURATION_UNAVAILABLE
            : noLongerInLine(gone.name)}
        </p>
      </div>
    );
  }
  return (
    <ConfigurationSourceContext.Provider
      key={JSON.stringify([viewerId, descriptor.environmentId])}
      value={source}
    >
      {gone.leftName === null ? null : (
        <p role="status" className="px-5 pt-5 text-ui-sm text-muted-foreground">
          {noLongerInLine(gone.leftName)}
        </p>
      )}
      {source.kind === "pool" && source.effectiveRole === "viewer" ? (
        <p className="px-5 pt-5 text-ui-sm text-muted-foreground">
          {viewerCanSeeLine(descriptor.label)}
        </p>
      ) : null}
      {props.children}
    </ConfigurationSourceContext.Provider>
  );
}

/** The invitation a picked team has, where it is a team and has one. */
function invitationFor(
  environmentId: string | null,
  invitations: readonly EnvironmentInvitation[],
): EnvironmentInvitation | null {
  if (environmentId === null) return null;
  return (
    invitations.find((entry) => entry.environmentId === environmentId) ?? null
  );
}

/**
 * What a page owes the person about the configuration it was showing: the name
 * of the team they are no longer in, while the list does not carry it and
 * something once read its name; nothing at all once the list carries it again.
 */
function leftNameFor(input: {
  readonly listed: string | null;
  readonly gone: boolean;
  readonly name: string | null;
  readonly current: string | null;
}): string | null {
  if (input.listed !== null) return null;
  if (input.gone && input.name !== null) return input.name;
  return input.current;
}

/**
 * The team the page was showing, once the list no longer carries it. A removal
 * moves the selection to Personal — a dead team leaves every page and the
 * picker's trigger reading an id nothing can name — and `leftName` carries the
 * reason onto the page the selection lands on. An invitation is not a
 * membership: the selection stays, so the trigger and the Review go on naming
 * the same team.
 */
function useGoneConfiguration(input: {
  readonly target: CloudConfigurationTarget;
  /** The picked configuration's label while the list carries it. */
  readonly listed: string | null;
  readonly settled: boolean;
}): {
  /** The gone team's name, or `null` where nothing ever named it. */
  readonly name: string | null;
  readonly invitation: EnvironmentInvitation | null;
  readonly leftName: string | null;
} {
  const { target, listed, settled } = input;
  const client = useHostClient();
  const invitations = useEnvironmentInvitationsQuery(client);
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  // The label the page read a moment ago: the only name a removed team has.
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const [leftName, setLeftName] = useState<string | null>(null);
  const environmentId = target.kind === "team" ? target.environmentId : null;
  const invitation = invitationFor(
    environmentId,
    invitations.data?.invitations ?? [],
  );
  const absent = settled && listed === null && environmentId !== null;
  const name = invitation?.teamName ?? lastLabel;
  // Nothing is gone while the invitations read is still open: an invitation
  // the page has not read yet is not "no longer in".
  const gone = absent && !invitations.isPending && invitation === null;

  // Adjusted while rendering, as the members page adjusts its settled read:
  // what the page last read, and what it owes the person once that is gone,
  // are derived from this render's answer, not synchronized after it. The
  // name is therefore remembered before the selection moves off the team.
  if (listed !== null && listed !== lastLabel) setLastLabel(listed);
  const nextLeftName = leftNameFor({ listed, gone, name, current: leftName });
  if (nextLeftName !== leftName) setLeftName(nextLeftName);

  useEffect(() => {
    // The selection is a store every page and the picker's trigger read, so
    // it moves after the render that found the team gone, never during it.
    // It moves whether or not the team can be named: no page can read it.
    if (!gone) return;
    setPick(PERSONAL_PICK);
  }, [gone, setPick]);

  return { name, invitation, leftName: nextLeftName };
}

/** The team invited the person back: its grant and Accept are one press away. */
function InvitedInstead(props: {
  readonly invitation: EnvironmentInvitation;
}): ReactNode {
  const [reviewing, setReviewing] = useState(false);
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="status" className="text-ui-sm text-muted-foreground">
        {invitedInsteadLine(props.invitation.teamName)}
      </p>
      <Button
        type="button"
        variant="link"
        size="inline"
        onClick={() => setReviewing(true)}
      >
        Review
      </Button>
      <InviteAcceptDialog
        invitation={reviewing ? props.invitation : null}
        onClose={() => setReviewing(false)}
        onAccepted={(environmentId) => {
          setReviewing(false);
          setPick({ kind: "team", environmentId });
        }}
      />
    </div>
  );
}
