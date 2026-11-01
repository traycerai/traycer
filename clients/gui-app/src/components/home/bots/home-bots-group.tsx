import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HomeBotsGroup } from "@/lib/home-bots/bots-model";
import type { HostRpcRegistry } from "@/lib/host";
import { botCreatedByLabel } from "@/lib/bots/bot-member-names";
import { useEnvironmentMembers } from "@/hooks/bots/use-environment-members-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import type { TeamSetup } from "@/hooks/bots/use-team-setups";
import {
  HomeBotRow,
  HomeSetupBotRow,
  type HomeBotHostReach,
} from "@/components/home/bots/home-bot-row";
import { CreateBotForm } from "@/components/home/bots/create-bot-form";

/**
 * One environment's card on Home: its label and kind, its bots, and the
 * create form that makes a bot INTO it - the environment is the card's, named
 * explicitly on the create, never a page-wide default. A team with no bot
 * whose main bot is still to be set up shows that bot, needing a host.
 */
export function HomeBotsGroupCard(props: {
  readonly group: HomeBotsGroup;
  readonly hostReach: HomeBotHostReach;
  /** The machines of this environment the reader may see beyond their own;
   * `null` while a team environment's list has not answered. */
  readonly environmentHostIds: ReadonlySet<string> | null;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
  /** The client the band reads through and its host: a team bot's row
   * names who made it when that host answers `environment.members`. */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** The team's main bot still to be set up, shown in place of its bots
   * (there are none); `null` for none. */
  readonly setup: TeamSetup | null;
}): ReactNode {
  const {
    setup,
    group,
    hostReach,
    environmentHostIds,
    connectableHostIds,
    environmentBindings,
    client,
    hostId,
  } = props;
  const [creating, setCreating] = useState(false);
  const isTeam = group.ownerKind === "organization";
  // Only a team bot has another member to name; a personal one asks nothing.
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
  const resolveMember = useEnvironmentMembers(
    client,
    isTeam ? group.environmentId : null,
    membersSupported && isTeam,
  );
  const viewerUserId = useAuthStore((s) => s.profile?.userId ?? null);
  // A team with no bot shows its main bot still to be set up, if it has one.
  const empty =
    setup === null ? (
      <p className="px-1 py-2 text-ui-xs text-muted-foreground">
        No bots here yet.
      </p>
    ) : (
      <HomeSetupBotRow setup={setup} hostReach={hostReach} />
    );

  return (
    <section
      data-testid="home-bots-group"
      data-environment-id={group.environmentId}
      aria-label={group.label}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate font-medium text-ui-sm text-foreground">
            {group.label}
          </h3>
          {group.ownerKind === null ? null : (
            <Badge variant="muted" size="xs">
              {group.ownerKind === "organization" ? "Team" : "Personal"}
            </Badge>
          )}
        </div>
        {group.canCreate ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={creating}
            data-testid="home-bots-create-toggle"
            onClick={() => setCreating((open) => !open)}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            New bot
          </Button>
        ) : null}
      </header>
      {creating && group.canCreate ? (
        <CreateBotForm
          environmentId={group.environmentId}
          environmentLabel={group.label}
          connectableHostIds={connectableHostIds}
          environmentBindings={environmentBindings}
          onCreated={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {group.bots.length === 0 ? (
        empty
      ) : (
        <ul className="flex flex-col gap-1">
          {group.bots.map((bot) => (
            <li key={bot.botId}>
              <HomeBotRow
                bot={bot}
                hostReach={hostReach}
                environmentHostIds={environmentHostIds}
                environmentOwnerKind={group.ownerKind}
                isMain={group.mainBotId === bot.botId}
                createdBy={botCreatedByLabel({
                  createdByUserId: bot.createdByUserId,
                  viewerUserId,
                  isTeamBot: isTeam,
                  resolveMember,
                })}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
