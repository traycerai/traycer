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
 * such host picked. Four states, each with its own remedy:
 *
 * - the host inventory could not be read: that, and Retry. An unread
 *   inventory is not an empty one, so this state claims nothing about where
 *   the configuration runs;
 * - a host can be picked: `Pick one.`, which opens the picker;
 * - the configuration runs somewhere, but nothing there can be reached right
 *   now: that, and Retry, which reads the host list again;
 * - nothing runs it at all: a sandbox of the configuration's.
 *
 * `Pick one.` is never offered where the picker would open with nothing in
 * it: a verb that leads nowhere is no remedy.
 */
export function TeamContentNeedsHost(props: {
  readonly content: TeamHostNeed;
  readonly teamName: string;
  readonly onPickHost: () => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const personal = useConfigurationIsPersonal();
  const hosts = scope.hosts.data?.hosts ?? [];
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
        pickable: hosts.some((host) => scope.canSelectHost(host.hostId)),
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
  if (!state.pickable && state.listed > 0) {
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
  return (
    <>
      <span>
        {NEED_OPENING[state.content]} a host running {state.teamName}.
      </span>
      {state.pickable ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={state.onPickHost}
        >
          Pick one.
        </Button>
      ) : (
        <span>
          Start {withIndefiniteArticle(state.teamName)} sandbox to see{" "}
          {state.content === "guide" ? "it" : "them"}.
        </span>
      )}
    </>
  );
}
