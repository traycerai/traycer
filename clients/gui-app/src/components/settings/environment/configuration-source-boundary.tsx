import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import {
  cancelEnvironmentInvitationReads,
  useEnvironmentInvitationsQuery,
} from "@/hooks/environment/use-environment-invitations";
import { useHostClient } from "@/lib/host";
import {
  moveEnvironmentPick,
  PERSONAL_PICK,
} from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { TeamReadFailed } from "./team-read-failed";
import { useConfigurationRevision } from "@/hooks/environment/use-configuration-revision";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

/** The team is gone from the person's memberships: they were removed from it. */
function noLongerInLine(teamName: string): string {
  return `You're no longer in ${teamName}.`;
}

/**
 * One toast per team the person is removed from. The removal unmounts the page
 * it happened on — the selection moves, and the frame is keyed by it — so the
 * id is the team's rather than the page's: a remount, another window's render
 * or a re-read of the same removal raises it once. A later removal from the
 * same team is a new one, and the list carries the team again in between.
 */
function leftToastId(environmentId: string): string {
  return `environment-left:${environmentId}`;
}

/**
 * The team invited them instead, so its settings are an Accept away — as much
 * of them as the invited role is given. A viewer's invitation promises reading
 * and nothing more.
 */
function invitedInsteadLine(invitation: EnvironmentInvitation): string {
  const lead = `You're invited to ${invitation.teamName}. Accept to see`;
  return invitation.role === "viewer"
    ? `${lead} its settings.`
    : `${lead} and change its settings.`;
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
  /**
   * The page this boundary wraps, so a removal can take the surface off a
   * page Personal does not offer. `null` where the caller is not a page of
   * the Environment group and nothing needs moving.
   */
  readonly section: SettingsSectionId | null;
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
    // The answer that raises the question, so the answer that settles it can
    // be held to being no older.
    listedAt: list.dataUpdatedAt,
    section: props.section,
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
    // The named removal is said as a toast, because the selection moves and
    // this page goes with it; what is left to say is that this page cannot be
    // read, for the frame it still owns.
    return (
      <div className="p-5">
        <p role="status" className="text-ui-sm text-muted-foreground">
          {CONFIGURATION_UNAVAILABLE}
        </p>
      </div>
    );
  }
  return (
    <ConfigurationSourceContext.Provider
      key={JSON.stringify([viewerId, descriptor.environmentId])}
      value={source}
    >
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

/** A label the page read, and the configuration it named. */
type ReadLabel = {
  readonly environmentId: string;
  readonly label: string;
};

/**
 * The question asked on account of one membership answer: when that answer
 * arrived, and what the invitations read had last answered at the moment it
 * was asked.
 *
 * The reply is that read's next answer, and never the promise `refetch` hands
 * back. That promise resolves with the OBSERVER's state, not with this
 * request's outcome: `QueryObserver.fetch` swallows the rejection and returns
 * `#currentResult`, so a request cancelled by anything else — another page
 * asking its own question, a sweep — resolves it with the answer already in
 * cache and `isSuccess` true. That is the answer from before the question.
 */
type AskedInvitations = {
  readonly listedAt: number;
  readonly answeredAt: number;
};

/**
 * The read asked for on account of the membership answer now in hand, or
 * `null` where none has been: one asked for an earlier answer says nothing
 * about this one, so a new membership answer asks again. Nothing else
 * refreshes that read — it does not poll, it does not refresh on focus, and
 * the configuration invalidator leaves it alone.
 */
function answerFor(
  asked: AskedInvitations | null,
  listedAt: number,
): AskedInvitations | null {
  if (asked === null || asked.listedAt !== listedAt) return null;
  return asked;
}

/** The remembered label, where it still names the configuration on screen. */
function labelOf(
  remembered: ReadLabel | null,
  environmentId: string | null,
): string | null {
  if (remembered === null || environmentId === null) return null;
  return remembered.environmentId === environmentId ? remembered.label : null;
}

/**
 * The label to remember from this render, or `null` to keep the one held. It
 * carries the configuration it names, so a label read for one team can never
 * be spoken about another.
 */
function labelToRemember(
  remembered: ReadLabel | null,
  environmentId: string | null,
  listed: string | null,
): ReadLabel | null {
  if (listed === null || environmentId === null) return null;
  if (
    remembered !== null &&
    remembered.environmentId === environmentId &&
    remembered.label === listed
  )
    return null;
  return { environmentId, label: listed };
}

/**
 * The team the page was showing, once the list no longer carries it. A removal
 * moves the selection to Personal, because a dead team leaves every page and
 * the picker's trigger reading an id nothing can name — and that move unmounts
 * this page, since the frame is keyed by the selection. So the removal is said
 * as a toast, which outlives the page it happened on, and nothing here is
 * carried across the move. An invitation is not a membership: the selection
 * stays, so the trigger and the Review go on naming the same team.
 */
function useGoneConfiguration(input: {
  readonly target: CloudConfigurationTarget;
  /** The picked configuration's label while the list carries it. */
  readonly listed: string | null;
  readonly settled: boolean;
  /** When the membership list that no longer carries it was answered. */
  readonly listedAt: number;
  /** The page this is happening on, which Personal may not offer. */
  readonly section: SettingsSectionId | null;
}): { readonly invitation: EnvironmentInvitation | null } {
  const { target, listed, settled, listedAt, section } = input;
  const client = useHostClient();
  const invitations = useEnvironmentInvitationsQuery(client);
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  // A removed team is in no list, so the label this page read a moment ago is
  // the only thing left that can name it.
  const [read, setRead] = useState<ReadLabel | null>(null);
  const environmentId = target.kind === "team" ? target.environmentId : null;
  const invitation = invitationFor(
    environmentId,
    invitations.data?.invitations ?? [],
  );
  const queryClient = useQueryClient();
  const { refetch: readInvitations } = invitations;
  const absent = settled && listed === null && environmentId !== null;
  const [asked, setAsked] = useState<AskedInvitations | null>(null);
  const answer = answerFor(asked, listedAt);

  // Asked once per membership answer, and only once the list stops carrying
  // the team: the read is account-wide, and nothing else has reason to
  // refresh it. Marked while rendering, like the label above it, so the
  // request below is started once for one question, and the answer it is
  // waiting for is named before anything can arrive.
  if (absent && answer === null)
    setAsked({ listedAt, answeredAt: invitations.dataUpdatedAt });

  useEffect(() => {
    if (answer === null) return;
    // Cancelled and asked in one step, with nothing awaited in between: the
    // cancel marks every retryer rejected before the read below looks at
    // them, so the read starts a request of its own instead of JOINING one
    // whose reply can carry a snapshot from before the membership answer —
    // and no observer is left sitting between a cancelled read and its
    // replacement.
    //
    // The promise is dropped on the floor, deliberately. What answers this
    // question is the read's next answer, below.
    cancelEnvironmentInvitationReads(queryClient);
    void readInvitations({ cancelRefetch: true });
  }, [answer, queryClient, readInvitations]);

  // Answered once the read has answered AGAIN since the question was asked.
  // With nothing in flight at the ask, an answer later than that one can only
  // come from a request started after the membership answer — which is the
  // provenance a timestamp cannot carry on its own, and the reason the cancel
  // above is load-bearing rather than tidiness. A read that fails moves
  // `errorUpdatedAt` and not this, so a failure is not an answer, and the one
  // thing a tie of the two stamps can cost is this question: the next
  // membership answer asks a new one.
  const answered =
    answer !== null && invitations.dataUpdatedAt > answer.answeredAt;

  // The team that is gone, where one is. Nothing is gone until the read asked
  // for this answer has answered: an invitation the page could not read is
  // not "no longer in", and neither is one it has not asked about yet. A
  // removal claimed on either would move the selection off a team the person
  // is about to be told they can rejoin. The page says it cannot be read
  // meanwhile, and the selection stays where the person put it.
  //
  // What that leaves is an invitation the server had not written when it
  // answered this question — one that lands after the request went out. It
  // cannot be in the reply, so a re-invitation inside that window reads as a
  // plain removal: the toast names the team, the selection moves to Personal,
  // and the Accept this page would have offered is not offered. The offer
  // returns without a reload, from the environment picker, bounded by that
  // read's own staleness: neither route of the invitations read sets a
  // `staleTime`, so it takes the app's 60s default, and `TeamRows` lives in
  // the picker's dropdown content, which mounts afresh on each open. An open
  // within 60s of the racing reply is served that reply from cache and shows
  // the same list; the first open after that reads invitations again, and the
  // team is a row there, marked `invited`, carrying the same Review that opens
  // `InviteAcceptDialog`.
  const goneId =
    absent && answered && invitation === null ? environmentId : null;

  // Captured while rendering, as the members page captures its settled read,
  // so the name is already in hand on the render that finds the team gone.
  const remembered = labelToRemember(read, environmentId, listed);
  if (remembered !== null) setRead(remembered);
  const label = labelOf(remembered ?? read, environmentId);

  useEffect(() => {
    if (goneId === null) return;
    // Said before the selection moves, and only with a name something read:
    // nothing else can say which team it was.
    if (label !== null)
      toast(noLongerInLine(label), { id: leftToastId(goneId) });
    // Personal has no Members page, and Members is the likeliest page to be
    // reading when a membership changes, so the move goes through the same
    // guard the picker's own moves do: it takes the surface off a page the
    // selection it lands on does not offer.
    //
    // The selection is a store every page and the picker's trigger read, so
    // it moves after the render that found the team gone, never during it. It
    // moves whether or not the team can be named: no page can read it.
    moveEnvironmentPick({
      next: PERSONAL_PICK,
      activeSection: section,
      setPick,
    });
  }, [goneId, label, section, setPick]);

  return { invitation };
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
        {invitedInsteadLine(props.invitation)}
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
