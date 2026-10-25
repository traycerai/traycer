import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderNativeScope,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import { useHostQueriesWithResponseMap } from "@/hooks/host/use-host-queries";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import {
  mapProvidersListToMcpServers,
  mapProvidersListToSkills,
} from "@/hooks/providers/native-response-map";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  nativeMcpListParams,
  nativeSkillsListParams,
} from "@/lib/query-keys/providers-native-query-keys";
import type { McpScopeTarget } from "@/components/settings/panels/provider-mcp-scope-picker";
import { useProviderNativeScope } from "@/components/settings/panels/use-provider-native-scope";
import { AddToConfigurationButton } from "./add-to-configuration-button";
import { onHostOnlyHeading, onHostScopePhrase } from "./mcp-skills-copy";
import { useConfigurationName } from "./mcp-servers-model";

/** One place on the viewing host a provider keeps entries by itself. */
interface HostPlace {
  readonly scope: ProviderNativeScope;
  /** The project or worktree; null for the provider's global settings. */
  readonly target: McpScopeTarget | null;
}

/** An entry a provider holds at one place, and only there. */
interface HostEntry {
  readonly name: string;
  readonly place: HostPlace;
}

/**
 * The provider's global settings, then each project and worktree this client
 * opened on the viewing host, as far as the provider lists `kind` there.
 */
function useHostPlaces(
  kind: "mcp" | "skills",
  providerId: ProviderId,
): readonly HostPlace[] {
  const scope = useTeamViewingHost();
  const catalog = useProvidersListForClient(scope.client, {
    enabled: scope.client !== null,
    subscribed: true,
  });
  const capabilities = catalog.data?.providers.find(
    (state) => state.providerId === providerId,
  )?.nativeCapabilities;
  const listScopes: readonly ProviderNativeScope[] = (kind === "mcp"
    ? capabilities?.mcp?.actionScopes.list
    : capabilities?.skills?.actionScopes.list) ?? ["global"];
  const { targets } = useProviderNativeScope(listScopes);
  const global: readonly HostPlace[] = listScopes.includes("global")
    ? [{ scope: "global", target: null }]
    : [];
  const projects: readonly HostPlace[] = listScopes.includes("project")
    ? targets.map((target) => ({ scope: "project", target }))
    : [];
  return [...global, ...projects];
}

function placeKey(place: HostPlace): string {
  return place.target === null ? "global" : place.target.path;
}

/**
 * The card under a provider's MCP or Skills tab: what the provider holds on
 * the viewing host by itself, each with where it is and "Add to <name>".
 * Drawn only when there is something.
 */
function OnHostOnlyCard(props: {
  readonly entryKind: "mcp" | "skills";
  readonly providerId: ProviderId;
  readonly entries: readonly HostEntry[];
}): ReactNode {
  const scope = useTeamViewingHost();
  const name = useConfigurationName();
  const host = scope.viewingHost;
  if (host === null || props.entries.length === 0) return null;
  const heading = onHostOnlyHeading(host.hostLabel ?? host.hostId);
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      aria-label={heading}
    >
      <h3 className="text-ui-sm font-medium">{heading}</h3>
      <ul className="flex flex-col gap-2">
        {props.entries.map((entry) => (
          <li
            key={`${placeKey(entry.place)}:${entry.name}`}
            className="flex items-center justify-between gap-3"
          >
            <div className="min-w-0">
              <div className="truncate text-ui-sm">{entry.name}</div>
              <div className="truncate text-ui-xs text-muted-foreground">
                {onHostScopePhrase(entry.place.target)}
              </div>
            </div>
            <AddToConfigurationButton
              entryKind={props.entryKind}
              providerId={props.providerId}
              scope={entry.place.scope}
              workspaceRoot={entry.place.target?.path ?? null}
              name={entry.name}
              configurationName={name}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The servers this provider holds on the viewing host that are not the
 * configuration's. At global scope one whose name the configuration holds is
 * the configuration's own copy, so it is not listed.
 */
export function OnHostOnlyServers(props: {
  readonly providerId: ProviderId;
  readonly environmentNames: readonly string[];
}): ReactNode {
  const places = useHostPlaces("mcp", props.providerId);
  const entries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "providers.list",
    readonly string[],
    readonly HostEntry[]
  >({
    client: useHostClient(),
    cacheKeyIdentity: "on-host-mcp",
    requests: places.map((place) => ({
      method: "providers.list",
      params: nativeMcpListParams({
        providerId: props.providerId,
        scope: place.scope,
        workspaceRoot: place.target?.path ?? null,
      }),
    })),
    options: { staleTime: 30_000, poll: false },
    mapResponse: ({ response }) =>
      mapProvidersListToMcpServers({ response }).servers.map(
        (server) => server.name,
      ),
    combine: (results) =>
      results.flatMap((result, index) => {
        const place = places[index];
        return (result.data ?? [])
          .filter(
            (serverName) =>
              place.target !== null ||
              !props.environmentNames.includes(serverName),
          )
          .map((serverName) => ({ name: serverName, place }));
      }),
  });
  return (
    <OnHostOnlyCard
      entryKind="mcp"
      providerId={props.providerId}
      entries={entries}
    />
  );
}

/** A skills list's on-host names: a name in both folders is one entry. */
function onHostSkillNames(skills: readonly ProviderSkill[]): readonly string[] {
  return [
    ...new Set(
      skills
        .filter(
          (skill) => skill.source === "provider" || skill.source === "shared",
        )
        .map((skill) => skill.name),
    ),
  ];
}

/**
 * The skills this provider holds in its own and the shared folders on the
 * viewing host. One whose name the configuration holds is not listed: the
 * configuration's copy is the one above. The global read refreshes itself, so
 * a skill a tool adds there shows; the projects' reads do not.
 */
export function OnHostOnlySkills(props: {
  readonly providerId: ProviderId;
  readonly environmentNames: readonly string[];
}): ReactNode {
  const places = useHostPlaces("skills", props.providerId);
  const globalPlace = places.find((place) => place.target === null) ?? null;
  const projectPlaces = places.filter((place) => place.target !== null);
  const global = useProvidersSkillsList({
    providerId: props.providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: globalPlace !== null,
  });
  const projectEntries = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "providers.list",
    readonly string[],
    readonly HostEntry[]
  >({
    client: useHostClient(),
    cacheKeyIdentity: "on-host-skills",
    requests: projectPlaces.map((place) => ({
      method: "providers.list",
      params: nativeSkillsListParams({
        providerId: props.providerId,
        scope: place.scope,
        workspaceRoot: place.target?.path ?? null,
      }),
    })),
    options: { staleTime: 30_000, poll: false },
    mapResponse: ({ response }) =>
      onHostSkillNames(mapProvidersListToSkills({ response }).skills),
    combine: (results) =>
      results.flatMap((result, index) => {
        const place = projectPlaces[index];
        return (result.data ?? []).map((skillName) => ({
          name: skillName,
          place,
        }));
      }),
  });
  const globalEntries: readonly HostEntry[] =
    globalPlace === null
      ? []
      : onHostSkillNames(global.data?.skills ?? []).map((skillName) => ({
          name: skillName,
          place: globalPlace,
        }));
  return (
    <OnHostOnlyCard
      entryKind="skills"
      providerId={props.providerId}
      entries={[...globalEntries, ...projectEntries].filter(
        (entry) => !props.environmentNames.includes(entry.name),
      )}
    />
  );
}
