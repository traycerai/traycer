import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  WorktreeBindingSelectorRowV12,
  WorktreeBindingSelectorSource,
  WorktreeHostEntryV14,
  WorktreeListAllForHostRequestV14,
} from "@traycer/protocol/host";
import {
  buildChatRowWorktreeMetadata,
  useEpicChatWorktreeMetadataForHost,
} from "@/hooks/worktree/use-epic-chat-worktree-metadata";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";

const OPEN_EPIC_ID = "epic-open";

afterEach(() => {
  cleanup();
});

describe("useEpicChatWorktreeMetadataForHost", () => {
  it("issues exactly one phase-1 and one phase-2 call per host regardless of row count", async () => {
    // 12 owners across 2 hosts: the batch exists so N rows never become N RPCs.
    const queryClient = createAppQueryClient();
    const localOwners = Array.from({ length: 6 }, (_, index) =>
      ownerId("chat", "local", index),
    );
    const remoteOwners = Array.from({ length: 6 }, (_, index) =>
      ownerId("terminal-agent", "remote", index),
    );
    const local = createHostFixture({
      queryClient,
      hostEntry: mockLocalHostEntry,
      epicId: OPEN_EPIC_ID,
      owners: localOwners.map((id, index) => ({
        ownerId: id,
        ownerKind: "chat" as const,
        branch: `feature/local-${String(index)}`,
        worktreePath: `/wt/local-${String(index)}`,
        workspacePath: `/repos/local-${String(index)}`,
      })),
    });
    const remote = createHostFixture({
      queryClient,
      hostEntry: mockRemoteHostEntry,
      epicId: OPEN_EPIC_ID,
      owners: remoteOwners.map((id, index) => ({
        ownerId: id,
        ownerKind: "terminal-agent" as const,
        branch: `feature/remote-${String(index)}`,
        worktreePath: `/wt/remote-${String(index)}`,
        workspacePath: `/repos/remote-${String(index)}`,
      })),
    });

    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        local: useEpicChatWorktreeMetadataForHost({
          client: local.client,
          epicId: OPEN_EPIC_ID,
          enabled: true,
        }),
        remote: useEpicChatWorktreeMetadataForHost({
          client: remote.client,
          epicId: OPEN_EPIC_ID,
          enabled: true,
        }),
      }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.local.size).toBe(6);
      expect(result.current.remote.size).toBe(6);
    });

    // Load-bearing: 2 hosts × (1 bindings + 1 enrichment) = 4 total, never 24.
    expect(local.counters.phase1Calls).toBe(1);
    expect(local.counters.phase2Calls).toBe(1);
    expect(remote.counters.phase1Calls).toBe(1);
    expect(remote.counters.phase2Calls).toBe(1);
    expect(
      local.counters.phase1Calls +
        local.counters.phase2Calls +
        remote.counters.phase1Calls +
        remote.counters.phase2Calls,
    ).toBe(4);

    for (const owner of localOwners) {
      expect(result.current.local.has(owner)).toBe(true);
    }
    for (const owner of remoteOwners) {
      expect(result.current.remote.has(owner)).toBe(true);
    }
  });

  it("maps both chat and terminal-agent owners from sources[]", async () => {
    const queryClient = createAppQueryClient();
    const chatOwnerId = "chat-owner-uuid";
    const terminalOwnerId = "terminal-owner-uuid";
    const fixture = createHostFixture({
      queryClient,
      hostEntry: mockLocalHostEntry,
      epicId: OPEN_EPIC_ID,
      owners: [
        {
          ownerId: chatOwnerId,
          ownerKind: "chat",
          branch: "feature/chat",
          worktreePath: "/wt/chat",
          workspacePath: "/repos/chat",
        },
        {
          ownerId: terminalOwnerId,
          ownerKind: "terminal-agent",
          branch: "feature/terminal",
          worktreePath: "/wt/terminal",
          workspacePath: "/repos/terminal",
        },
      ],
    });

    const { result } = renderHook(
      () =>
        useEpicChatWorktreeMetadataForHost({
          client: fixture.client,
          epicId: OPEN_EPIC_ID,
          enabled: true,
        }),
      { wrapper: queryWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });
    expect(result.current.get(chatOwnerId)?.label).toBe("feature/chat");
    expect(result.current.get(terminalOwnerId)?.label).toBe("feature/terminal");
  });

  it("calls phase 1 with the open epic id and never maps foreign owners", async () => {
    const queryClient = createAppQueryClient();
    const openChatId = "open-chat-owner";
    const foreignChatId = "foreign-chat-owner";
    const fixture = createHostFixture({
      queryClient,
      hostEntry: mockLocalHostEntry,
      epicId: OPEN_EPIC_ID,
      owners: [
        {
          ownerId: openChatId,
          ownerKind: "chat",
          branch: "feature/open",
          worktreePath: "/wt/open",
          workspacePath: "/repos/open",
        },
      ],
      // Host-side filter: a foreign epic's owners never cross the wire for this
      // epicId. The mock refuses to return them when phase 1 asks for OPEN_EPIC_ID.
      foreignOwners: [
        {
          ownerId: foreignChatId,
          ownerKind: "chat",
          branch: "feature/foreign",
          worktreePath: "/wt/foreign",
          workspacePath: "/repos/foreign",
        },
      ],
    });

    const { result } = renderHook(
      () =>
        useEpicChatWorktreeMetadataForHost({
          client: fixture.client,
          epicId: OPEN_EPIC_ID,
          enabled: true,
        }),
      { wrapper: queryWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });

    expect(fixture.counters.phase1EpicIds).toEqual([OPEN_EPIC_ID]);
    expect(result.current.has(openChatId)).toBe(true);
    expect(result.current.has(foreignChatId)).toBe(false);
    // Phase 2 is bounded to the open epic's worktree paths only.
    expect(fixture.counters.phase2ActivityPathSets).toEqual([["/wt/open"]]);
  });
});

describe("buildChatRowWorktreeMetadata", () => {
  it("picks the primary source directory, with insertion-order fallback", () => {
    const withPrimary = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: "/wt/a",
          branch: "branch-a",
          workspacePath: "/repos/a",
          sources: [
            source({
              ownerId: "owner-1",
              workspacePath: "/repos/a",
              isPrimary: false,
            }),
          ],
        }),
        selectorRow({
          worktreePath: "/wt/b",
          branch: "branch-b",
          workspacePath: "/repos/b",
          sources: [
            source({
              ownerId: "owner-1",
              workspacePath: "/repos/b",
              isPrimary: true,
            }),
          ],
        }),
      ],
      [],
    );
    expect(withPrimary.get("owner-1")?.label).toBe("branch-b");

    const noPrimary = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: "/wt/first",
          branch: "first-branch",
          workspacePath: "/repos/first",
          sources: [
            source({
              ownerId: "owner-2",
              workspacePath: "/repos/first",
              isPrimary: false,
            }),
          ],
        }),
        selectorRow({
          worktreePath: "/wt/second",
          branch: "second-branch",
          workspacePath: "/repos/second",
          sources: [
            source({
              ownerId: "owner-2",
              workspacePath: "/repos/second",
              isPrimary: false,
            }),
          ],
        }),
      ],
      [],
    );
    // Insertion order: the first directory seen for the owner is the fallback.
    expect(noPrimary.get("owner-2")?.label).toBe("first-branch");
  });

  it("labels from branch when present, else workspace folder name", () => {
    const withBranch = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: "/wt/feature",
          branch: "feature/with-branch",
          workspacePath: "/Users/me/projects/my-app",
          sources: [
            source({
              ownerId: "owner-branch",
              workspacePath: "/Users/me/projects/my-app",
              isPrimary: true,
            }),
          ],
        }),
      ],
      [],
    );
    expect(withBranch.get("owner-branch")?.label).toBe("feature/with-branch");

    const localNoBranch = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: null,
          branch: null,
          mode: "local",
          workspacePath: "/Users/me/projects/my-app",
          runningDir: "/Users/me/projects/my-app",
          sources: [
            source({
              ownerId: "owner-local",
              workspacePath: "/Users/me/projects/my-app",
              isPrimary: true,
              mode: "local",
            }),
          ],
        }),
      ],
      [],
    );
    expect(localNoBranch.get("owner-local")?.label).toBe("my-app");
  });

  it("counts extra directories plus owned submodules", () => {
    const map = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: "/wt/primary",
          branch: "main",
          workspacePath: "/repos/primary",
          sources: [
            source({
              ownerId: "owner-extra",
              workspacePath: "/repos/primary",
              isPrimary: true,
            }),
          ],
        }),
        selectorRow({
          worktreePath: "/wt/secondary",
          branch: "side",
          workspacePath: "/repos/secondary",
          sources: [
            source({
              ownerId: "owner-extra",
              workspacePath: "/repos/secondary",
              isPrimary: false,
            }),
          ],
        }),
      ],
      [
        hostEntry({
          worktreePath: "/wt/primary",
          branch: "main",
          submodules: [
            {
              repoIdentifier: { owner: "acme", repo: "lib-a" },
              branch: "lib-a-branch",
              prState: null,
              prNumber: null,
              prUrl: null,
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
              unmergedCommitCount: null,
              unmergedCommitSubjects: null,
            },
            {
              repoIdentifier: { owner: "acme", repo: "lib-b" },
              branch: "lib-b-branch",
              prState: null,
              prNumber: null,
              prUrl: null,
              mergedHeadShaMatches: false,
              mergedIntoDefault: false,
              atPinnedCommit: false,
              unmergedCommitCount: null,
              unmergedCommitSubjects: null,
            },
          ],
        }),
        hostEntry({
          worktreePath: "/wt/secondary",
          branch: "side",
          submodules: [],
        }),
      ],
    );
    // 1 extra directory + 2 submodules on the primary worktree.
    expect(map.get("owner-extra")?.extraCount).toBe(3);
  });

  it("counts distinct running directories, not repeated binding entries", () => {
    // One running directory reached through TWO workspace paths - an imported
    // worktree bound under a second path. The badge reads "+N more workspaces",
    // so counting the entry twice claims a place the agent does not work in.
    const map = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: "/wt/shared",
          branch: "main",
          workspacePath: "/repos/first",
          sources: [
            source({
              ownerId: "owner-dup",
              workspacePath: "/repos/first",
              isPrimary: true,
            }),
            source({
              ownerId: "owner-dup",
              workspacePath: "/repos/second",
              isPrimary: false,
            }),
          ],
        }),
      ],
      [],
    );

    expect(map.get("owner-dup")?.extraCount).toBe(0);
  });

  it("still counts two genuinely different running directories", () => {
    const map = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: "/wt/one",
          branch: "main",
          workspacePath: "/repos/one",
          sources: [
            source({
              ownerId: "owner-two-dirs",
              workspacePath: "/repos/one",
              isPrimary: true,
            }),
          ],
        }),
        selectorRow({
          worktreePath: "/wt/two",
          branch: "side",
          workspacePath: "/repos/two",
          sources: [
            source({
              ownerId: "owner-two-dirs",
              workspacePath: "/repos/two",
              isPrimary: false,
            }),
          ],
        }),
      ],
      [],
    );

    expect(map.get("owner-two-dirs")?.extraCount).toBe(1);
  });

  it("collects PR references across an owner's directories", () => {
    const map = buildChatRowWorktreeMetadata(
      [
        selectorRow({
          worktreePath: "/wt/a",
          branch: "a",
          workspacePath: "/repos/a",
          sources: [
            source({
              ownerId: "owner-prs",
              workspacePath: "/repos/a",
              isPrimary: true,
            }),
          ],
        }),
        selectorRow({
          worktreePath: "/wt/b",
          branch: "b",
          workspacePath: "/repos/b",
          sources: [
            source({
              ownerId: "owner-prs",
              workspacePath: "/repos/b",
              isPrimary: false,
            }),
          ],
        }),
      ],
      [
        hostEntry({
          worktreePath: "/wt/a",
          branch: "a",
          prState: "open",
          prNumber: 10,
          prUrl: "https://github.com/acme/app/pull/10",
        }),
        hostEntry({
          worktreePath: "/wt/b",
          branch: "b",
          prState: "merged",
          prNumber: 20,
          prUrl: "https://github.com/acme/app/pull/20",
        }),
      ],
    );
    const refs = map.get("owner-prs")?.prReferences ?? [];
    expect(refs.map((ref) => ref.prNumber)).toEqual([10, 20]);
    expect(refs.map((ref) => ref.state)).toEqual(["open", "merged"]);
  });

  it("omits owners with no directories entirely rather than mapping empty metadata", () => {
    const map = buildChatRowWorktreeMetadata([], []);
    expect(map.size).toBe(0);
    expect(map.has("missing-owner")).toBe(false);
  });
});

interface OwnerSeed {
  readonly ownerId: string;
  readonly ownerKind: "chat" | "terminal-agent";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly workspacePath: string;
}

interface HostCallCounters {
  phase1Calls: number;
  phase2Calls: number;
  readonly phase1EpicIds: string[];
  readonly phase2ActivityPathSets: string[][];
}

function ownerId(
  kind: "chat" | "terminal-agent",
  host: string,
  index: number,
): string {
  return `${kind}-${host}-${String(index)}`;
}

function queryWrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function source(
  overrides: Partial<WorktreeBindingSelectorSource> & {
    readonly ownerId: string;
    readonly workspacePath: string;
  },
): WorktreeBindingSelectorSource {
  return {
    ownerKind: "chat",
    isPrimary: true,
    mode: "worktree",
    ...overrides,
  };
}

function selectorRow(
  overrides: Partial<WorktreeBindingSelectorRowV12> & {
    readonly sources: readonly WorktreeBindingSelectorSource[];
  },
): WorktreeBindingSelectorRowV12 {
  const workspacePath = overrides.workspacePath ?? "/repos/default";
  const worktreePath =
    overrides.worktreePath === undefined
      ? "/wt/default"
      : overrides.worktreePath;
  return {
    hostId: mockLocalHostEntry.hostId,
    runningDir: overrides.runningDir ?? worktreePath ?? workspacePath,
    workspacePath,
    worktreePath,
    mode: overrides.mode ?? "worktree",
    isGitRepo: overrides.isGitRepo ?? true,
    repoIdentifier:
      overrides.repoIdentifier === undefined
        ? { owner: "acme", repo: "app" }
        : overrides.repoIdentifier,
    branch: overrides.branch === undefined ? "main" : overrides.branch,
    isPrimary: overrides.isPrimary ?? true,
    isImported: overrides.isImported ?? false,
    setupState: overrides.setupState ?? "not_required",
    disabledReason: overrides.disabledReason ?? null,
    sources: [...overrides.sources],
    isGitResolvePending: overrides.isGitResolvePending ?? false,
  };
}

function hostEntry(
  overrides: Partial<WorktreeHostEntryV14> & { readonly worktreePath: string },
): WorktreeHostEntryV14 {
  const base: WorktreeHostEntryV14 = {
    worktreePath: overrides.worktreePath,
    branch: "main",
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: 1,
  };
  return { ...base, ...overrides };
}

function createHostFixture(args: {
  readonly queryClient: QueryClient;
  readonly hostEntry: HostDirectoryEntry;
  readonly epicId: string;
  readonly owners: readonly OwnerSeed[];
  readonly foreignOwners?: readonly OwnerSeed[];
}): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly counters: HostCallCounters;
} {
  const foreignOwners = args.foreignOwners ?? [];
  const counters: HostCallCounters = {
    phase1Calls: 0,
    phase2Calls: 0,
    phase1EpicIds: [],
    phase2ActivityPathSets: [],
  };
  let requestSeq = 0;

  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(args.queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq += 1;
        return `req-${args.hostEntry.hostId}-${String(requestSeq)}`;
      },
      handlers: {
        "worktree.listBindingsForEpic": (params) => {
          counters.phase1Calls += 1;
          counters.phase1EpicIds.push(params.epicId);
          // Host-side epic filter: only owners for the requested epic.
          const seeds =
            params.epicId === args.epicId ? args.owners : foreignOwners;
          return {
            rows: seeds.map((seed) =>
              selectorRow({
                hostId: args.hostEntry.hostId,
                worktreePath: seed.worktreePath,
                branch: seed.branch,
                workspacePath: seed.workspacePath,
                runningDir: seed.worktreePath ?? seed.workspacePath,
                mode: seed.worktreePath === null ? "local" : "worktree",
                sources: [
                  source({
                    ownerId: seed.ownerId,
                    ownerKind: seed.ownerKind,
                    workspacePath: seed.workspacePath,
                    isPrimary: true,
                    mode: seed.worktreePath === null ? "local" : "worktree",
                  }),
                ],
              }),
            ),
            folderlessCwd: null,
          };
        },
        "worktree.listAllForHost": (
          params: WorktreeListAllForHostRequestV14,
        ) => {
          counters.phase2Calls += 1;
          const activityPaths = params.activityPaths ?? [];
          counters.phase2ActivityPathSets.push([...activityPaths]);
          return {
            worktrees: activityPaths.map((worktreePath) =>
              hostEntry({
                worktreePath,
                branch: `branch-for-${worktreePath}`,
                prState: "open",
                prNumber: 1,
                prUrl: `https://github.com/acme/app/pull/1?path=${encodeURIComponent(worktreePath)}`,
              }),
            ),
            nextCursor: null,
          };
        },
      },
    }),
  });
  client.bind(args.hostEntry);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return { client, counters };
}
