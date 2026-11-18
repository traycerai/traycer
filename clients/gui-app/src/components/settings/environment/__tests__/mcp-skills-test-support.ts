import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { McpScopeTarget } from "@/components/settings/panels/provider-mcp-scope-picker";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentMcpServerDeclaration } from "@traycer/protocol/host/environment/configuration-contracts";
import type {
  ProviderMcpServer,
  ProviderMcpTool,
  ProviderNativeScope,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";

/** The host id the page under test addresses: the window's host. */
export const WINDOW_HOST_ID = mockLocalHostEntry.hostId;

type Version = { readonly major: number; readonly minor: number };

/** What the window's host advertised at its handshake; a page reads this before it draws. */
export function negotiateMethods(
  methods: Readonly<Record<string, Version>>,
): void {
  negotiateMethodsOn(WINDOW_HOST_ID, methods);
}

export function negotiateMethodsOn(
  hostId: string,
  methods: Readonly<Record<string, Version>>,
): void {
  recordNegotiatedHostManifest(hostId, { ...methods });
}

export const reachableHost: EnvironmentHostRecordV12 = {
  hostId: "host-a",
  hostLabel: "Mac mini",
  hostPlatform: "darwin",
  enrolledByUserId: "u-1",
  kind: "personal",
  boundAt: 1,
  reachable: true,
  lastReportedAt: 1,
  hasLocalRow: false,
  applied: [],
};

export const teamEnvironments = {
  environments: [
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "editor" as const,
      kind: "team" as const,
      hostCount: 1,
      providerHandle: "handle-a",
    },
  ],
};

/** A provider row of the catalog, with the native lists it advertises. */
export function providerState(
  providerId: ProviderId,
  lists: { readonly mcp: boolean; readonly skills: boolean },
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: [],
      mcp: lists.mcp
        ? {
            transports: ["stdio", "http"],
            authTypes: ["none"],
            authActions: [],
            actionScopes: {
              list: ["global"],
              add: ["global"],
              update: ["global"],
              remove: ["global"],
              toggleServer: ["global"],
              toggleTool: ["global"],
              discover: ["global"],
              auth: [],
            },
            addServer: "cli",
            removeServer: "cli",
            updateServer: "patch",
            perToolBacking: "native",
            statusSource: "probe",
            toolsSource: "probe",
            schemasSource: "probe",
            instructionsSource: "probe",
            traycerSessionsOnlyEnforcement: false,
            stdioDegradeNotice: false,
            oauthDegradesToConfigOnly: false,
          }
        : null,
      plugins: null,
      skills: lists.skills
        ? {
            actionScopes: {
              list: ["global"],
              add: [],
              create: [],
              import: [],
              remove: [],
            },
          }
        : null,
      modelProviders: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

/** A server as the viewing host lists it for a provider, with its tools. */
export function hostMcpServer(
  name: string,
  tools: readonly string[],
): ProviderMcpServer {
  return {
    name,
    enabled: true,
    transport: { type: "http", url: `https://${name}.invalid/mcp`, auth: null },
    status: "connected",
    statusSource: "probe",
    statusDetail: null,
    tools: tools.map((tool): ProviderMcpTool => ({
      name: tool,
      description: null,
      inputSchema: null,
      enabled: true,
      readOnly: false,
    })),
    discoveryPending: false,
    instructions: null,
    configOnly: false,
    stdioDegraded: false,
  };
}

export function hostSkill(
  name: string,
  source: ProviderSkill["source"],
): ProviderSkill {
  return {
    name,
    description: `${name} skill`,
    path: `/Users/dev/.agents/skills/${name}`,
    source,
  };
}

/** One server of the environment; `item` null is a server switched off. */
export function declaredServer(
  server: Pick<EnvironmentMcpServerDeclaration, "serverId" | "name"> &
    Partial<EnvironmentMcpServerDeclaration>,
): EnvironmentMcpServerDeclaration {
  return {
    transport: "http",
    url: `https://${server.name}.invalid/mcp`,
    command: null,
    args: [],
    env: [],
    credential: {
      kind: "none",
      secretId: null,
      secretName: null,
      owned: false,
    },
    item: {
      key: server.name,
      revision: 4,
      toolToggles: {},
      offFor: [],
    },
    ...server,
  };
}

/**
 * The projects and worktrees the viewing host's picker offers; a suite's
 * `useProviderNativeScope` mock reads this, since the real hook needs the
 * app's workspace stores.
 */
export const nativeScopeTargets: { current: readonly McpScopeTarget[] } = {
  current: [],
};

export function nativeScopeFor(listScopes: readonly ProviderNativeScope[]) {
  return {
    hostId: "host-1",
    targets: nativeScopeTargets.current,
    workspaceRoot: null,
    setWorkspaceRoot: (_path: string): void => undefined,
    browseForWorkspace: (): Promise<string | null> => Promise.resolve(null),
    browsePending: false,
    multiWorkspace: false,
    multiScope: listScopes.includes("project"),
    effectiveScope: "global" as const,
    setScope: (_scope: ProviderNativeScope): void => undefined,
    projectNeedsWorkspace: false,
    listWorkspaceRoot: null,
    listEnabled: true,
    workspacesLoading: false,
  };
}

/** A provider whose MCP and Skills lists reach projects as well as global. */
export function projectScopedProviderState(
  providerId: ProviderId,
): ProviderCliState {
  const base = providerState(providerId, { mcp: true, skills: true });
  const { mcp, skills } = base.nativeCapabilities;
  return {
    ...base,
    nativeCapabilities: {
      ...base.nativeCapabilities,
      mcp:
        mcp === null
          ? null
          : {
              ...mcp,
              actionScopes: {
                ...mcp.actionScopes,
                list: ["global", "project"],
              },
            },
      skills:
        skills === null
          ? null
          : {
              ...skills,
              actionScopes: {
                ...skills.actionScopes,
                list: ["global", "project"],
              },
            },
    },
  };
}

/** Where a native list request reads: "global", or "project:<path>". */
export function hostPlaceKey(
  scope: ProviderNativeScope,
  workspaceRoot: string | null,
): string {
  return workspaceRoot === null ? scope : `${scope}:${workspaceRoot}`;
}
