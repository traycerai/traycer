import type { ReactNode } from "react";
import { Check, Clock, Eye, X, type LucideIcon } from "lucide-react";
import type {
  PrActivitySection,
  PrActor,
  PrDetailCore,
  PrReviewState,
} from "@traycer/protocol/host/pr-schemas";
import { PrActorAvatar } from "@/components/epic-canvas/pr/pr-detail-avatar";
import { PrOwnerLabel } from "@/components/epic-canvas/pr/pr-owner-label";
import { cn } from "@/lib/utils";

type PrReviewerState = PrReviewState | "requested";

const REVIEWER_STATE_ICON: Record<
  PrReviewerState,
  {
    readonly Icon: LucideIcon;
    readonly className: string;
    readonly label: string;
  }
> = {
  requested: {
    Icon: Clock,
    className: "text-muted-foreground/70",
    label: "Review requested",
  },
  approved: {
    Icon: Check,
    className: "text-green-600 dark:text-green-400",
    label: "Approved",
  },
  changes_requested: {
    Icon: X,
    className: "text-red-600 dark:text-red-400",
    label: "Requested changes",
  },
  commented: {
    Icon: Eye,
    className: "text-muted-foreground",
    label: "Reviewed",
  },
  dismissed: {
    Icon: Eye,
    className: "text-muted-foreground/70",
    label: "Review dismissed",
  },
  pending: {
    Icon: Clock,
    className: "text-muted-foreground/70",
    label: "Review pending",
  },
};

interface PrSidebarReviewer {
  readonly actor: PrActor;
  readonly state: PrReviewerState;
}

/**
 * Reviewer rows GitHub-style: reviewers who already reviewed carry their
 * latest review state (activity is chronological, so later entries win);
 * a pending re-request from `reviewRequests` overrides to "requested".
 */
function reviewerRows(
  core: PrDetailCore,
  activity: PrActivitySection,
): readonly PrSidebarReviewer[] {
  const byLogin = new Map<string, PrSidebarReviewer>();
  for (const item of activity.items) {
    if (item.kind !== "review" || item.author === null) continue;
    byLogin.set(item.author.login, { actor: item.author, state: item.state });
  }
  for (const request of core.reviewRequests) {
    byLogin.set(request.login, { actor: request, state: "requested" });
  }
  return [...byLogin.values()];
}

/** Unique actors seen on the PR: the author plus everyone in the activity feed. */
function participantActors(
  core: PrDetailCore,
  activity: PrActivitySection,
): readonly PrActor[] {
  const byLogin = new Map<string, PrActor>();
  if (core.author !== null) byLogin.set(core.author.login, core.author);
  for (const item of activity.items) {
    if (item.author !== null) byLogin.set(item.author.login, item.author);
  }
  return [...byLogin.values()];
}

/**
 * GitHub's right sidebar, reduced to the facts we carry: Reviewers,
 * Development (the owning Traycer chat/agent - the closest analogue to
 * GitHub's linked-development section), and Participants.
 */
export function PrDetailSidebar(props: {
  readonly core: PrDetailCore;
  readonly activity: PrActivitySection;
  readonly className: string | undefined;
}): ReactNode {
  const reviewers = reviewerRows(props.core, props.activity);
  const participants = participantActors(props.core, props.activity);

  return (
    <aside
      className={cn("flex min-w-0 flex-col text-ui-xs", props.className)}
      data-testid="pr-detail-sidebar"
    >
      <PrSidebarSection heading="Reviewers">
        {reviewers.length === 0 ? (
          <PrSidebarNoReviewers
            // Reviewer state is reconstructed from the last-~20 activity window,
            // which newer comments can push a review out of. Only claim a
            // definitive "No reviews" when the window is complete AND the
            // authoritative review decision agrees there were none; otherwise
            // the approval may simply be off-window (and the merge box, which
            // reads `reviewDecision`, would say "Approved" beside it).
            uncertain={
              props.activity.isTruncated || props.core.reviewDecision !== null
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {reviewers.map((reviewer) => {
              const state = REVIEWER_STATE_ICON[reviewer.state];
              return (
                <li
                  key={reviewer.actor.login}
                  className="flex min-w-0 items-center gap-2"
                >
                  <PrActorAvatar
                    actor={reviewer.actor}
                    size="sm"
                    className={undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {reviewer.actor.login}
                  </span>
                  <state.Icon
                    className={cn("size-3.5 shrink-0", state.className)}
                    aria-label={state.label}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </PrSidebarSection>
      <PrSidebarSection heading="Development">
        {props.core.owners.length === 0 ? (
          <p className="text-muted-foreground/70">None yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {props.core.owners.map((owner) => (
              <li
                key={`${owner.ownerKind}:${owner.ownerId}`}
                className="flex min-w-0"
              >
                <PrOwnerLabel owner={owner} className="text-foreground" />
              </li>
            ))}
          </ul>
        )}
      </PrSidebarSection>
      {participants.length > 0 ? (
        <PrSidebarSection
          heading={`${participants.length} participant${participants.length === 1 ? "" : "s"}`}
        >
          <div className="flex flex-wrap gap-1.5">
            {participants.map((actor) => (
              <PrActorAvatar
                key={actor.login}
                actor={actor}
                size="sm"
                className={undefined}
              />
            ))}
          </div>
        </PrSidebarSection>
      ) : null}
    </aside>
  );
}

function PrSidebarNoReviewers(props: {
  readonly uncertain: boolean;
}): ReactNode {
  return (
    <p className="text-muted-foreground/70">
      {props.uncertain ? "See GitHub for review history" : "No reviews"}
    </p>
  );
}

function PrSidebarSection(props: {
  readonly heading: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="border-b border-border/50 py-3 first:pt-0 last:border-b-0">
      <h3 className="mb-2 text-ui-xs font-semibold text-muted-foreground">
        {props.heading}
      </h3>
      {props.children}
    </section>
  );
}
