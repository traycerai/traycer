import type { ReactNode } from "react";
import { withIndefiniteArticle } from "@traycer/protocol/host/notifications/indefinite-article";
import { Button } from "@/components/ui/button";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useConfigurationIsPersonal } from "./configuration-source";

/** What a card needs a host for, as its line opens. */
export type TeamHostNeed =
  | "guide"
  | "skills"
  | "rate-limits"
  | "live-values"
  | "model-tiers";

const NEED_OPENING: Readonly<Record<TeamHostNeed, string>> = {
  guide: "The guide needs",
  skills: "Skills need",
  "rate-limits": "Rate limits need",
  "live-values": "Live values need",
  "model-tiers": "Model tiers need",
};

/**
 * A card that only a host running the picked configuration can fill, with no
 * such host picked. Five states:
 *
 * - the host inventory has not answered yet: no line at all, since an unread
 *   inventory is not an empty one;
 * - the host inventory could not be read: that, and Retry. An unread
 *   inventory is not an empty one, so this state claims nothing about where
 *   the configuration runs;
 * - the configuration runs somewhere, but nothing there can be reached right
 *   now: that, and Retry, which reads the host list again;
 * - a host OTHER than the one being viewed can be picked: `Pick one.`, which
 *   opens the picker;
 * - the only host that can be picked is the one already being viewed: the
 *   opening alone. Picking is no remedy when there is nothing to switch to;
 * - nothing runs it at all: a sandbox of the configuration's.
 *
 * `Pick one.` is offered on the picker's own predicate — an eligible host
 * that is not the viewed one — so the verb is never drawn where the picker
 * would open with nothing in it.
 */
export function TeamContentNeedsHost(props: {
  readonly content: TeamHostNeed;
  readonly teamName: string;
  readonly onPickHost: () => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const personal = useConfigurationIsPersonal();
  const hosts = scope.hosts.data?.hosts ?? [];
  // An inventory still being read is not an empty one either: until it
  // answers, the card has nothing true to say about where the configuration
  // runs, so it says nothing. The line arrives with the answer.
  if (scope.hosts.isPending) return null;
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-1 text-ui-sm text-muted-foreground"
    >
      {needsHostLine({
        content: props.content,
        teamName: props.teamName,
        personal,
        unread: scope.hosts.isError,
        listed: hosts.length,
        reachable: hosts.some((host) => scope.canSelectHost(host.hostId)),
        // The picker's own predicate: it draws a Select only for an eligible
        // host that is not the one being viewed, so that is the only state in
        // which `Pick one.` opens anything.
        pickable: hosts.some(
          (host) =>
            host.hostId !== scope.viewingHost?.hostId &&
            scope.canSelectHost(host.hostId),
        ),
        onPickHost: props.onPickHost,
        onRetry: () => void scope.hosts.refetch(),
      })}
    </p>
  );
}

/** The line the card reads, by what the host inventory says. */
function needsHostLine(state: {
  readonly content: TeamHostNeed;
  readonly teamName: string;
  readonly personal: boolean;
  readonly unread: boolean;
  readonly listed: number;
  /** Whether any listed host can be reached at all. */
  readonly reachable: boolean;
  /** Whether one of those is a host other than the one being viewed. */
  readonly pickable: boolean;
  readonly onPickHost: () => void;
  readonly onRetry: () => void;
}): ReactNode {
  const retry = (
    <Button type="button" variant="link" size="sm" onClick={state.onRetry}>
      Retry
    </Button>
  );
  if (state.unread) {
    return (
      <>
        <span>
          Couldn&apos;t read {state.teamName}&apos;s{" "}
          {state.personal ? "computers" : "hosts"}.
        </span>
        {retry}
      </>
    );
  }
  if (!state.reachable && state.listed > 0) {
    return (
      <>
        <span>
          No {state.personal ? "computer" : "host"} running {state.teamName} can
          be reached.
        </span>
        {retry}
      </>
    );
  }
  const opening = (
    <span>
      {NEED_OPENING[state.content]} a host running {state.teamName}.
    </span>
  );
  if (state.pickable) {
    return (
      <>
        {opening}
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={state.onPickHost}
        >
          Pick one.
        </Button>
      </>
    );
  }
  // A reachable host with nothing to switch to: the one that can be picked is
  // the one already being viewed, so the opening is the whole line.
  if (state.reachable) return opening;
  return (
    <>
      {opening}
      <span>
        Start {withIndefiniteArticle(state.teamName)} sandbox to see{" "}
        {state.content === "guide" ? "it" : "them"}.
      </span>
    </>
  );
}
