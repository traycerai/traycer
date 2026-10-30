import { useId, useMemo, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { Button } from "@/components/ui/button";
import { useHostClient } from "@/lib/host/runtime";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { BotsUnavailableNotice } from "@/components/bots/bots-unavailable-notice";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useRereadEnvironmentListOnFocus } from "@/hooks/bots/use-reread-environment-list-on-focus";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotListChangedSubscriptionForApp } from "@/hooks/bots/use-bot-list-changed-subscription";
import { useHostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useTeamSetups } from "@/hooks/bots/use-team-setups";
import {
  buildHomeBotsModel,
  EMPTY_HOME_BOTS_MODEL,
  type HomeBotsGroup,
} from "@/lib/home-bots/bots-model";
import { HomeBotsGroupCard } from "@/components/home/bots/home-bots-group";
import { useDashboardPageOpener } from "@/components/settings/host-scope/use-dashboard-page-opener";
import {
  createTeamDashboardUrl,
  hasNoTeamEnvironment,
} from "@/lib/home-bots/create-team-dashboard";

/** The Home tab's own section heading, so this reads as one of its bands. */
const HEADING_CLASS_NAME = "tracking-[0.08em] uppercase";
const EMPTY_ENVIRONMENTS: ReadonlyArray<EnvironmentDescriptor> = [];
const EMPTY_BOTS: ReadonlyArray<BotRecord> = [];
const NO_MACHINES: ReadonlySet<string> = new Set();

/** The groups once both lists have answered; `null` before, as
 * `useTeamSetups` reads it. */
function answeredGroups(
  groups: ReadonlyArray<HomeBotsGroup>,
  environmentsAnswered: boolean,
  botsAnswered: boolean,
): ReadonlyArray<HomeBotsGroup> | null {
  return environmentsAnswered && botsAnswered ? groups : null;
}

/**
 * The bots band on Home (Tracy Bots): every environment the reader belongs
 * to, side by side, each with its bots and its own create form, and, for a
 * reader in no team, a card that opens the dashboard page where a team is
 * made.
 *
 * Read through the app-wide host like the rest of Home. The host answers for
 * every environment from the cloud, so which host serves the list does not
 * change it. No machine is named anywhere in the band: a row says whether its
 * bot is working, idle or paused, and its tab opens through this window's
 * host, which finds the one that serves the bot.
 * On a host whose handshake has no `bot.list` the band shows the same update
 * notice the usage panel uses, and nothing else on Home changes.
 */
export function HomeBotsSection(): ReactNode {
  const hostId = useEffectiveHostId();
  const client = useHostClient();
  const support = useHostMethodSupport(hostId, "bot.list");
  const enabled = support === true;
  const environments = useEnvironmentListQuery(client, enabled);
  useRereadEnvironmentListOnFocus(enabled);
  const bots = useBotListQuery(client, enabled);
  // A teammate's change to the list refetches it without waiting for focus.
  useBotListChangedSubscriptionForApp(enabled);
  const directory = useHostDirectoryList();
  const connectable = useConnectableHostIds();
  const bindings = useHostEnvironmentBindings(connectable.hostIds, enabled);
  const hostListSupport = useHostMethodSupport(hostId, "environment.host.list");
  const headingId = useId();

  const registeredHosts = useRegisteredHosts();
  // `undefined` while loading or failed with nothing kept, `null` with no
  // signed-in registry: neither is an answer.
  const registry = registeredHosts.data ?? null;
  const hostReach = useMemo(
    () => ({
      directoryHostIds: new Set(
        (directory.data ?? []).map((entry) => entry.hostId),
      ),
      connectableHostIds: new Set(connectable.hostIds),
      connectableResolved: connectable.resolved,
      // An unanswered registry is not "no personal hosts": the rows read
      // it as not known yet.
      personalHostIds:
        registry === null
          ? null
          : new Set(
              registry.hosts
                .filter((host) => host.kind === "personal")
                .map((host) => host.hostId),
            ),
    }),
    [connectable.hostIds, connectable.resolved, directory.data, registry],
  );
  const environmentList = environments.data?.environments ?? EMPTY_ENVIRONMENTS;
  // A team environment's machines the reader may see beyond their own (its
  // sandboxes), for each row's paused state; a personal one has none.
  const teamEnvironmentIds = useMemo(
    () =>
      environmentList
        .filter((environment) => environment.ownerKind === "organization")
        .map((environment) => environment.environmentId),
    [environmentList],
  );
  const environmentHosts = useEnvironmentHostLists(
    client,
    teamEnvironmentIds,
    enabled && hostListSupport === true,
  );
  const environmentHostIds = useMemo(() => {
    const byEnvironmentId = new Map<string, ReadonlySet<string>>();
    // A failed list stays out of the map, read as unanswered: the rows say
    // idle rather than claim a machine is away.
    for (const [
      environmentId,
      hosts,
    ] of environmentHosts.hostsByEnvironmentId) {
      byEnvironmentId.set(
        environmentId,
        new Set(hosts.map((host) => host.hostId)),
      );
    }
    return byEnvironmentId;
  }, [environmentHosts.hostsByEnvironmentId]);
  const botList = bots.data?.bots ?? EMPTY_BOTS;
  const model = useMemo(
    () =>
      environments.data === undefined && bots.data === undefined
        ? EMPTY_HOME_BOTS_MODEL
        : buildHomeBotsModel({
            environments: environmentList,
            bots: botList,
            mainBotIds: bots.data?.mainBotIds ?? null,
          }),
    [bots.data, environmentList, environments.data, botList],
  );
  const teamSetups = useTeamSetups({
    client,
    hostId,
    groups: answeredGroups(
      model.groups,
      environments.data !== undefined,
      bots.data !== undefined,
    ),
  });

  // The handshake has not answered yet: nothing to say either way, and a band
  // that flashes "unavailable" before every connect is worse than a late one.
  if (support === null) return null;

  let body: ReactNode;
  if (!support) {
    body = <BotsUnavailableNotice testId="home-bots-unavailable" />;
  } else if (environments.isError || bots.isError) {
    body = (
      <div
        role="status"
        data-testid="home-bots-error"
        className="mx-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
      >
        <span>Couldn&apos;t load your bots.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void environments.refetch();
            void bots.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  } else if (environments.data === undefined || bots.data === undefined) {
    body = (
      <div
        data-testid="home-bots-loading"
        aria-busy="true"
        className="mx-3 h-24 animate-pulse rounded-lg bg-foreground/10"
      />
    );
  } else {
    body = (
      <div className="grid gap-3 px-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {model.groups.map((group) => (
          <HomeBotsGroupCard
            key={group.environmentId}
            group={group}
            hostReach={hostReach}
            environmentHostIds={
              group.ownerKind === "organization"
                ? (environmentHostIds.get(group.environmentId) ?? null)
                : NO_MACHINES
            }
            connectableHostIds={connectable.hostIds}
            environmentBindings={bindings}
            client={client}
            hostId={hostId}
            setup={
              teamSetups.setups.find(
                (setup) => setup.environmentId === group.environmentId,
              ) ?? null
            }
          />
        ))}
        <CreateTeamCard environments={environments.data.environments} />
      </div>
    );
  }

  return (
    <section
      data-testid="home-bots"
      aria-labelledby={headingId}
      className="@container flex flex-col gap-1"
    >
      <div className="flex items-center justify-between gap-3 px-3 pt-4 pb-1 text-ui-xs text-muted-foreground">
        <h2 id={headingId} className={HEADING_CLASS_NAME}>
          Bots
        </h2>
        {support && bots.data !== undefined ? (
          <span className="tabular-nums" data-testid="home-bots-count">
            {model.botCount === 1 ? "1 bot" : `${model.botCount} bots`}
          </span>
        ) : null}
      </div>
      {body}
    </section>
  );
}

/**
 * Where a team's card would be, for a reader in no team: the dashboard page
 * that makes one, outside the app. Nothing once a team is listed, or with no
 * shell to open it.
 */
function CreateTeamCard(props: {
  readonly environments: ReadonlyArray<EnvironmentDescriptor>;
}): ReactNode {
  const open = useDashboardPageOpener(createTeamDashboardUrl);
  if (open === null || !hasNoTeamEnvironment(props.environments)) return null;
  return (
    <section
      data-testid="home-bots-create-team"
      aria-label="Create a team"
      className="flex min-w-0 flex-col items-start gap-2 rounded-lg border border-border/60 bg-card/40 p-3"
    >
      <h3 className="font-medium text-ui-sm text-foreground">Teams</h3>
      <p className="text-ui-xs text-muted-foreground">
        A team&apos;s bots work for everyone on the team.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="home-bots-create-team-open"
        onClick={open}
      >
        <ExternalLink className="size-3.5 shrink-0" aria-hidden />
        Create a team
      </Button>
    </section>
  );
}
