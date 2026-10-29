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
 * such host picked. Three states, each with its own remedy:
 *
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
  const pickable = hosts.some((host) => scope.canSelectHost(host.hostId));
  const object = props.content === "guide" ? "it" : "them";
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-1 text-ui-sm text-muted-foreground"
    >
      {!pickable && hosts.length > 0 ? (
        <>
          <span>
            No {personal ? "computer" : "host"} running {props.teamName} can be
            reached.
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => void scope.hosts.refetch()}
          >
            Retry
          </Button>
        </>
      ) : (
        <>
          <span>
            {NEED_OPENING[props.content]} a host running {props.teamName}.
          </span>
          {pickable ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={props.onPickHost}
            >
              Pick one.
            </Button>
          ) : (
            <span>
              Start {withIndefiniteArticle(props.teamName)} sandbox to see{" "}
              {object}.
            </span>
          )}
        </>
      )}
    </p>
  );
}
