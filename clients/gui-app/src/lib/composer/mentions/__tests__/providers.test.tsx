import { describe, expect, it } from "vitest";
import type {
  ComposerMentionProviderContext,
  MentionFlowStep,
  MentionMenuEntry,
  MentionSearchPathsRequest,
} from "../providers";
import {
  EMPTY_GITHUB_SECTION_CONTEXT,
  GITHUB_MENTION_HELD_ROWS_DISABLED_REASON,
  githubMentionCategoryAvailable,
  mentionProviderRegistry,
  ROOT_MENTION_STEP,
} from "../providers";
import type {
  BrowserTabMentionEntry,
  EpicChatMentionEntry,
  EpicTerminalAgentMentionEntry,
  EpicTerminalMentionEntry,
} from "@/lib/composer/types";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";

function context(
  overrides: Partial<ComposerMentionProviderContext>,
): ComposerMentionProviderContext {
  return {
    roots: ["/repo"],
    query: "",
    limit: 25,
    workspaceEntries: [],
    epicEntries: [],
    currentEpicId: null,
    agentEntries: [],
    terminalEntries: [],
    browserTabEntries: [],
    epicAttachedRoots: new Set(),
    github: {
      pullRequests: EMPTY_GITHUB_SECTION_CONTEXT,
      issues: EMPTY_GITHUB_SECTION_CONTEXT,
      // The default fixture is a host that HAS both mention methods, so the
      // existing cases keep exercising the categories rather than the
      // unsupported-host gate. The gate has its own cases below.
      supported: true,
      now: 0,
    },
    ...overrides,
  };
}

function terminal(fields: {
  terminalId: string;
  label: string;
  cwd: string;
  updatedAt: number;
}): EpicTerminalMentionEntry {
  return {
    kind: "epic-terminal",
    id: `terminal:epic-1:${fields.terminalId}`,
    token: `terminal:epic-1/${fields.terminalId}`,
    epicId: "epic-1",
    terminalId: fields.terminalId,
    label: fields.label,
    description: fields.cwd,
    cwd: fields.cwd,
    updatedAt: fields.updatedAt,
  };
}

function chatAgent(
  chatId: string,
  label: string,
  updatedAt: number,
): EpicChatMentionEntry {
  return {
    kind: "epic-chat",
    id: `chat:epic-1:${chatId}`,
    token: `chat:epic-1/${chatId}`,
    epicId: "epic-1",
    epicTitle: "Auth epic",
    chatId,
    label,
    description: "Auth epic",
    parentId: null,
    updatedAt,
    archived: false,
    agentInterface: "chat",
    runtimeSupportsMessageDelivery: true,
  };
}

function terminalAgent(fields: {
  terminalAgentId: string;
  label: string;
  harnessId: TuiHarnessId;
  runtimeSupportsMessageDelivery: boolean;
  updatedAt: number;
}): EpicTerminalAgentMentionEntry {
  const {
    terminalAgentId,
    label,
    harnessId,
    runtimeSupportsMessageDelivery,
    updatedAt,
  } = fields;
  return {
    kind: "epic-terminal-agent",
    id: `terminal-agent:epic-1:${terminalAgentId}`,
    token: `terminal-agent:epic-1/${terminalAgentId}`,
    epicId: "epic-1",
    epicTitle: "Auth epic",
    terminalAgentId,
    harnessId,
    label,
    description: "Auth epic",
    parentId: null,
    updatedAt,
    archived: false,
    agentInterface: "terminal",
    runtimeSupportsMessageDelivery,
  };
}

function browserTab(fields: {
  tabId: string;
  sessionId: string;
  label: string;
  url: string;
  coLocated: boolean;
  lastActivityAt: number;
  dormant: boolean;
}): BrowserTabMentionEntry {
  return {
    kind: "browser-tab",
    id: `browser-tab:${fields.sessionId}:${fields.tabId}`,
    tabId: fields.tabId,
    sessionId: fields.sessionId,
    label: fields.label,
    url: fields.url,
    coLocated: fields.coLocated,
    lastActivityAt: fields.lastActivityAt,
    dormant: fields.dormant,
  };
}

function labels(entries: ReadonlyArray<MentionMenuEntry>): string[] {
  return entries.map((entry) => entry.label);
}

function navigateEntry(entry: MentionMenuEntry) {
  if (entry.action.kind !== "navigate") {
    throw new Error(`expected navigate entry: ${entry.label}`);
  }
  return entry.action.step;
}

/**
 * Resolve a category by its label rather than its index. Root ordering is a
 * separate assertion in this file; a positional lookup here means inserting a
 * category silently re-points these tests at a different step instead of
 * failing where the ordering actually changed.
 */
function entryByLabel(
  entries: ReadonlyArray<MentionMenuEntry>,
  label: string,
): MentionMenuEntry {
  const found = entries.find((entry) => entry.label === label);
  if (found === undefined) {
    throw new Error(`no entry labelled ${label}`);
  }
  return found;
}

function completeEntry(entry: MentionMenuEntry) {
  if (entry.action.kind !== "complete") {
    throw new Error(`expected complete entry: ${entry.label}`);
  }
  return entry.action.mention;
}

describe("mention provider registry", () => {
  it("returns root providers in the composer order", () => {
    expect(
      labels(mentionProviderRegistry.entries(ROOT_MENTION_STEP, context({}))),
    ).toEqual([
      "Files",
      "Folders",
      "Worktrees",
      "Git",
      "Pull requests",
      "Issues",
      "Task",
      "Artifacts",
    ]);
  });

  /**
   * `mention.githubCatalog` / `mention.githubSearch` are optional (non-floor)
   * RPCs, so a host predating them negotiates them away rather than failing
   * the handshake. Left ungated, both categories stay selectable against such
   * a host and render permanently empty - the RPC rejects, the rejection is
   * swallowed into the section's degraded state, and the user is shown a
   * category that looks broken rather than one that is absent.
   */
  it("hides both GitHub categories when the host does not serve the mention methods", () => {
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        github: {
          pullRequests: EMPTY_GITHUB_SECTION_CONTEXT,
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: false,
          now: 0,
        },
      }),
    );

    expect(labels(entries)).toEqual([
      "Files",
      "Folders",
      "Worktrees",
      "Git",
      "Task",
      "Artifacts",
    ]);
  });

  // Root search is a SECOND way into the same rows, so a category hidden from
  // the root menu but still answering flat search would be hidden in name only
  // - and its reference-resolve row would drill into a step no host can serve.
  it("contributes no root-search rows when the host does not serve the mention methods", () => {
    const unsupported = context({
      query: "#123",
      github: {
        pullRequests: EMPTY_GITHUB_SECTION_CONTEXT,
        issues: EMPTY_GITHUB_SECTION_CONTEXT,
        supported: false,
        now: 0,
      },
    });

    // Positive control first. Two absence assertions on their own stay green
    // if the labels are renamed, or if `entries` stops returning anything at
    // all for this query - so pin that a SUPPORTED host does produce exactly
    // the rows whose absence is the claim below.
    const supportedLabels = labels(
      mentionProviderRegistry.entries(
        ROOT_MENTION_STEP,
        context({ query: "#123" }),
      ),
    );
    expect(supportedLabels).toContain("Resolve in Pull requests...");
    expect(supportedLabels).toContain("Resolve in Issues...");

    const unsupportedLabels = labels(
      mentionProviderRegistry.entries(ROOT_MENTION_STEP, unsupported),
    );
    expect(unsupportedLabels).not.toContain("Resolve in Pull requests...");
    expect(unsupportedLabels).not.toContain("Resolve in Issues...");
  });

  it("counts an author-login root match toward the zero-match verdict", () => {
    // `githubMentionMatchScore` matches the author's login, so the source
    // includes this row at root - but no rendered segment carries the login.
    // The entry's search-only text is what lets the root ranker reproduce
    // that match; without it the row rode the appended, unmatched tail with
    // `matchedCount: 0`, and the settled zero-match dismissal closed the
    // picker over a row it was showing.
    const row: GithubMentionRow = {
      kind: "pull-request",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
      number: 4917,
      title: "Stop the busy-loop",
      url: "https://github.com/traycerai/traycer/pull/4917",
      author: { login: "octocat", avatarUrl: null },
      updatedAt: 1_000,
      buckets: ["recent"],
      state: "open",
      isDraft: false,
      baseRefName: null,
      headRefName: null,
      reviewDecision: null,
      checksRollup: null,
    };

    const searched = mentionProviderRegistry.entriesWithMatches(
      ROOT_MENTION_STEP,
      context({
        query: "octocat",
        github: {
          pullRequests: {
            rows: [row],
            rowsHeld: false,
            repositories: [
              { githubHost: "github.com", owner: "traycerai", repo: "traycer" },
            ],
          },
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: true,
          now: 0,
        },
      }),
    );

    expect(searched.matchedCount).toBe(1);
  });

  /**
   * Held rows are the PREVIOUS filter's answer kept on screen while the new
   * filter's search runs (see `useHeldRowsDuringSearch` in
   * `use-github-mention-sections`). They stay visible for continuity but must
   * not be committable under the funnel's new claim, so the provider marks
   * their entries inert with the shared, screen-reader-facing reason.
   */
  it("marks a held row's entry inert with the shared disabled reason", () => {
    const row: GithubMentionRow = {
      kind: "pull-request",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
      number: 4917,
      title: "Stop the busy-loop",
      url: "https://github.com/traycerai/traycer/pull/4917",
      author: { login: "alice", avatarUrl: null },
      updatedAt: 1_000,
      buckets: ["recent"],
      state: "open",
      isDraft: false,
      baseRefName: null,
      headRefName: null,
      reviewDecision: null,
      checksRollup: null,
    };
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "pull-requests",
      stepId: "pull-requests",
      workspacePath: null,
    };

    const entries = mentionProviderRegistry.entries(
      step,
      context({
        github: {
          pullRequests: {
            rows: [row],
            rowsHeld: true,
            repositories: [
              { githubHost: "github.com", owner: "traycerai", repo: "traycer" },
            ],
          },
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: true,
          now: 0,
        },
      }),
    );

    expect(entryByLabel(entries, "Stop the busy-loop").disabledReason).toBe(
      GITHUB_MENTION_HELD_ROWS_DISABLED_REASON,
    );
  });

  it("leaves the row committable when rowsHeld is false", () => {
    // The control. Without it, a bug that disabled every GitHub row
    // unconditionally would pass the case above too.
    const row: GithubMentionRow = {
      kind: "pull-request",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
      number: 4917,
      title: "Stop the busy-loop",
      url: "https://github.com/traycerai/traycer/pull/4917",
      author: { login: "alice", avatarUrl: null },
      updatedAt: 1_000,
      buckets: ["recent"],
      state: "open",
      isDraft: false,
      baseRefName: null,
      headRefName: null,
      reviewDecision: null,
      checksRollup: null,
    };
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "pull-requests",
      stepId: "pull-requests",
      workspacePath: null,
    };

    const entries = mentionProviderRegistry.entries(
      step,
      context({
        github: {
          pullRequests: {
            rows: [row],
            rowsHeld: false,
            repositories: [
              { githubHost: "github.com", owner: "traycerai", repo: "traycer" },
            ],
          },
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: true,
          now: 0,
        },
      }),
    );

    expect(
      entryByLabel(entries, "Stop the busy-loop").disabledReason,
    ).toBeNull();
  });

  it("adds Agents as a current-epic provider covering both interfaces", () => {
    const agentEntries = [
      chatAgent("chat-1", "Kickoff chat", 10),
      terminalAgent({
        terminalAgentId: "tui-1",
        label: "Refactor run",
        harnessId: "claude",
        runtimeSupportsMessageDelivery: true,
        updatedAt: 20,
      }),
      terminalAgent({
        terminalAgentId: "tui-2",
        label: "Codex run",
        harnessId: "codex",
        runtimeSupportsMessageDelivery: false,
        updatedAt: 5,
      }),
    ];
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({ currentEpicId: "epic-1", agentEntries }),
    );

    expect(labels(entries)).toEqual([
      "Files",
      "Folders",
      "Worktrees",
      "Git",
      "Pull requests",
      "Issues",
      "Task",
      "Agents",
      "Terminals",
      "Artifacts",
    ]);

    const agentRows = mentionProviderRegistry.entries(
      navigateEntry(entryByLabel(entries, "Agents")),
      context({ currentEpicId: "epic-1", agentEntries }),
    );

    // Chat- and Terminal-interface Agents sit in ONE category. With no query
    // every row scores equally, so recency decides the order.
    expect(labels(agentRows)).toEqual([
      "Back",
      "Refactor run",
      "Kickoff chat",
      "Codex run",
    ]);
    expect(
      mentionProviderRegistry.menuCopy(
        navigateEntry(entryByLabel(entries, "Agents")),
      ),
    ).toEqual({ header: "Agents", empty: "No agents available" });

    expect(completeEntry(agentRows[2])).toMatchObject({
      contextType: "chat",
      path: "chat:epic-1/chat-1",
      epicId: "epic-1",
      chatId: "chat-1",
    });
    expect(completeEntry(agentRows[1])).toMatchObject({
      contextType: "terminal-agent",
      path: "terminal-agent:epic-1/tui-1",
      epicId: "epic-1",
      terminalAgentId: "tui-1",
    });
  });

  it("lists Task terminals in their own category, separate from Agents", () => {
    const terminalEntries = [
      terminal({
        terminalId: "term-1",
        label: "repo · zsh",
        cwd: "/repo",
        updatedAt: 10,
      }),
      terminal({
        terminalId: "term-2",
        label: "web · vite",
        cwd: "/repo/apps/web",
        updatedAt: 20,
      }),
    ];
    const agentEntries = [chatAgent("chat-1", "Kickoff chat", 30)];
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({ currentEpicId: "epic-1", agentEntries, terminalEntries }),
    );
    const terminalsStep = navigateEntry(entryByLabel(entries, "Terminals"));

    const rows = mentionProviderRegistry.entries(
      terminalsStep,
      context({ currentEpicId: "epic-1", agentEntries, terminalEntries }),
    );

    // Terminals never appear under Agents: a shell has no inbox, so listing it
    // there would imply it can be messaged.
    expect(labels(rows)).toEqual(["Back", "web · vite", "repo · zsh"]);
    expect(rows.map((row) => row.detail)).toEqual([
      "",
      "/repo/apps/web",
      "/repo",
    ]);
    expect(mentionProviderRegistry.menuCopy(terminalsStep)).toEqual({
      header: "Terminals",
      empty: "No terminals available",
    });
  });

  it("completes a terminal row into a pointer-only terminal mention", () => {
    const terminalEntries = [
      terminal({
        terminalId: "term-1",
        label: "repo · zsh",
        cwd: "/repo",
        updatedAt: 10,
      }),
    ];
    const rows = mentionProviderRegistry.entries(
      {
        kind: "provider",
        providerId: "terminals",
        stepId: "root",
        workspacePath: null,
      },
      context({ currentEpicId: "epic-1", terminalEntries }),
    );

    expect(completeEntry(rows[1])).toMatchObject({
      contextType: "terminal",
      path: "terminal:epic-1/term-1",
      epicId: "epic-1",
      terminalId: "term-1",
      label: "repo · zsh",
      // A mention is a pointer: no terminal output rides along with it.
      chatId: null,
      terminalAgentId: null,
      artifactId: null,
    });
  });

  it("hides the Terminals category outside an open Task", () => {
    expect(
      labels(
        mentionProviderRegistry.entries(
          ROOT_MENTION_STEP,
          context({ currentEpicId: null }),
        ),
      ),
    ).not.toContain("Terminals");
  });

  it("labels each Agent row by interface, and marks unsupported delivery without hiding it", () => {
    const agentEntries = [
      chatAgent("chat-1", "Kickoff", 10),
      terminalAgent({
        terminalAgentId: "tui-1",
        label: "Claude run",
        harnessId: "claude",
        runtimeSupportsMessageDelivery: true,
        updatedAt: 9,
      }),
      terminalAgent({
        terminalAgentId: "tui-2",
        label: "Codex run",
        harnessId: "codex",
        runtimeSupportsMessageDelivery: false,
        updatedAt: 8,
      }),
      terminalAgent({
        terminalAgentId: "tui-3",
        label: "OpenCode run",
        harnessId: "opencode",
        runtimeSupportsMessageDelivery: false,
        updatedAt: 7,
      }),
    ];
    const rows = mentionProviderRegistry
      .entries(
        {
          kind: "provider",
          providerId: "chat",
          stepId: "root",
          workspacePath: null,
        },
        context({ currentEpicId: "epic-1", agentEntries }),
      )
      .slice(1);

    // The row detail carries harness and reference-only capability, never an
    // interface label; the trailing slot's time rides `updatedAt` separately.
    expect(rows.map((row) => row.detail)).toEqual([
      "",
      "Claude Code",
      "Codex · Reference only",
      "OpenCode · Reference only",
    ]);
    expect(rows.map((row) => row.updatedAt)).toEqual([10, 9, 8, 7]);
    // Reference-only Agents stay selectable - only delivery is unavailable.
    expect(rows.every((row) => row.action.kind === "complete")).toBe(true);
  });

  it("ranks archived Agents below live ones at equal match quality", () => {
    const rows = mentionProviderRegistry
      .entries(
        {
          kind: "provider",
          providerId: "chat",
          stepId: "root",
          workspacePath: null,
        },
        context({
          currentEpicId: "epic-1",
          agentEntries: [
            // The archived record is the more recent one: archived-ness must
            // outweigh recency, not just tie-break it.
            { ...chatAgent("chat-arch", "Archived run", 100), archived: true },
            chatAgent("chat-live", "Live run", 10),
          ],
        }),
      )
      .slice(1);

    expect(rows.map((row) => row.id)).toEqual([
      "chat:epic-1:chat-live",
      "chat:epic-1:chat-arch",
    ]);
    expect(rows.map((row) => row.archived)).toEqual([false, true]);
    // Archived rows carry no time: the record clock is bumped by the archive
    // write itself, so a label would always claim the archive action as
    // activity. The badge alone marks them.
    expect(rows.map((row) => row.updatedAt)).toEqual([10, null]);
  });

  it("never lets archived-ness override match quality", () => {
    const rows = mentionProviderRegistry
      .entries(
        {
          kind: "provider",
          providerId: "chat",
          stepId: "root",
          workspacePath: null,
        },
        context({
          currentEpicId: "epic-1",
          query: "auth",
          agentEntries: [
            chatAgent("chat-live", "my oauth notes", 10),
            { ...chatAgent("chat-arch", "auth runner", 5), archived: true },
          ],
        }),
      )
      .slice(1);

    // The archived prefix hit still beats the live substring hit: demotion
    // applies within a match-quality band, never across bands.
    expect(rows.map((row) => row.id)).toEqual([
      "chat:epic-1:chat-arch",
      "chat:epic-1:chat-live",
    ]);
  });

  it("carries the archived demotion into root search within a match tier", () => {
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        currentEpicId: "epic-1",
        query: "auth",
        agentEntries: [
          // Same label = same fuzzy score and same prefix tier: the tie falls
          // back to the provider's input order, where archived sorts last.
          { ...chatAgent("chat-arch", "auth runner", 100), archived: true },
          chatAgent("chat-live", "auth runner", 10),
          // A live substring hit sits in a LOWER tier than the archived
          // prefix hits - demotion never lifts it above them.
          chatAgent("chat-sub", "my auth helper", 200),
        ],
      }),
    );

    const agentIds = entries
      .map((entry) => entry.id)
      .filter((id) => id.startsWith("chat:epic-1:"));
    expect(agentIds).toEqual([
      "chat:epic-1:chat-live",
      "chat:epic-1:chat-arch",
      "chat:epic-1:chat-sub",
    ]);
  });

  it("filters mixed-interface Agents by query and falls back to untitled labels", () => {
    const rows = mentionProviderRegistry
      .entries(
        {
          kind: "provider",
          providerId: "chat",
          stepId: "root",
          workspacePath: null,
        },
        context({
          currentEpicId: "epic-1",
          query: "untitled",
          agentEntries: [
            chatAgent("chat-1", "Untitled chat", 10),
            terminalAgent({
              terminalAgentId: "tui-1",
              label: "Untitled terminal agent",
              harnessId: "codex",
              runtimeSupportsMessageDelivery: false,
              updatedAt: 9,
            }),
            terminalAgent({
              terminalAgentId: "tui-2",
              label: "Refactor run",
              harnessId: "claude",
              runtimeSupportsMessageDelivery: true,
              updatedAt: 8,
            }),
          ],
        }),
      )
      .slice(1);

    expect(labels(rows)).toEqual(["Untitled chat", "Untitled terminal agent"]);
  });

  it("uses provider search rows instead of static root providers when querying", () => {
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        query: "auth",
        workspaceEntries: [
          {
            kind: "file",
            id: "file:/repo:src/auth.ts",
            label: "auth.ts",
            relPath: "src/auth.ts",
            absolutePath: "/repo/src/auth.ts",
            workspacePath: "/repo",
            description: "src",
          },
          {
            kind: "folder",
            id: "folder:/repo:src/auth/",
            label: "auth",
            relPath: "src/auth/",
            absolutePath: "/repo/src/auth",
            workspacePath: "/repo",
            description: "src",
          },
        ],
        epicEntries: [
          {
            kind: "epic",
            id: "epic:epic-1",
            token: "epic:epic-1",
            epicId: "epic-1",
            label: "Auth epic",
            description: "1 spec",
            status: "active",
            updatedAt: 10,
          },
          {
            kind: "epic-artifact",
            id: "spec:epic-1:spec-1",
            token: "spec:epic-1/spec-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            artifactId: "spec-1",
            artifactType: "spec",
            label: "Auth spec",
            description: "Auth epic",
            status: null,
            updatedAt: 20,
          },
        ],
        agentEntries: [chatAgent("chat-1", "Auth chat", 20)],
        currentEpicId: "epic-1",
      }),
    );

    // Root search returns one flat, cross-provider ranked list; membership is
    // asserted here and the ranking itself in root-search-ranking.test.ts.
    expect(labels(entries).toSorted()).toEqual(
      ["auth.ts", "auth", "Auth epic", "Auth chat", "Auth spec"].toSorted(),
    );
    const byLabel = (label: string): MentionMenuEntry => {
      const entry = entries.find((candidate) => candidate.label === label);
      if (entry === undefined) throw new Error(`missing entry: ${label}`);
      return entry;
    };
    expect(completeEntry(byLabel("Auth chat"))).toMatchObject({
      contextType: "chat",
      path: "chat:epic-1/chat-1",
    });
    expect(completeEntry(byLabel("Auth spec"))).toMatchObject({
      contextType: "spec",
      path: "spec:epic-1/spec-1",
    });
  });

  it("keeps git workspace and submenu navigation inside the git provider", () => {
    const rootEntries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({ roots: ["/work/repo-a", "/work/repo-b"] }),
    );
    const gitStep = navigateEntry(rootEntries[3]);
    expect(gitStep).toMatchObject({
      kind: "provider",
      providerId: "git",
      stepId: "workspaces",
    });

    const workspaceEntries = mentionProviderRegistry.entries(
      gitStep,
      context({ roots: ["/work/repo-a", "/work/repo-b"] }),
    );
    expect(labels(workspaceEntries)).toEqual(["Back", "repo-a", "repo-b"]);

    const gitRootStep = navigateEntry(workspaceEntries[1]);
    expect(gitRootStep).toMatchObject({
      kind: "provider",
      providerId: "git",
      stepId: "root",
      workspacePath: "/work/repo-a",
    });

    const gitRows = mentionProviderRegistry.entries(
      gitRootStep,
      context({
        workspaceEntries: [
          {
            kind: "git",
            id: "git:branch:/work/repo-a:main",
            label: "Diff against branch 'main'",
            description: "repo-a",
            workspacePath: "/work/repo-a",
            gitType: "against_branch",
            branchName: "main",
            commitHash: null,
          },
        ],
      }),
    );
    expect(labels(gitRows)).toEqual([
      "Back",
      "Diff against branch 'main'",
      "Diff against branch...",
      "Diff against commit...",
    ]);
    expect(navigateEntry(gitRows[2])).toMatchObject({
      providerId: "git",
      stepId: "branches",
      workspacePath: "/work/repo-a",
    });
    expect(completeEntry(gitRows[1])).toMatchObject({
      contextType: "git",
      path: "git:branch:main",
    });
  });

  it("surfaces worktrees as directory-context mentions", () => {
    const worktreeStep = navigateEntry(
      mentionProviderRegistry.entries(ROOT_MENTION_STEP, context({}))[2],
    );
    expect(worktreeStep).toMatchObject({
      kind: "provider",
      providerId: "worktree",
    });

    expect(
      mentionProviderRegistry
        .workspaceRequests(worktreeStep, context({ query: "feat" }))
        .map((request) => request.method),
    ).toEqual(["workspace.mentionWorktrees"]);

    const rows = mentionProviderRegistry.entries(
      worktreeStep,
      context({
        workspaceEntries: [
          {
            kind: "worktree",
            id: "worktree:/repo:/home/u/.traycer/worktrees/o/r/feature",
            label: "feature",
            worktreePath: "/home/u/.traycer/worktrees/o/r/feature",
            workspacePath: "/repo",
            branch: "feature",
            isMain: false,
            description: "/home/u/.traycer/worktrees/o/r/feature",
          },
        ],
      }),
    );
    expect(labels(rows)).toEqual(["Back", "feature"]);
    expect(completeEntry(rows[1])).toMatchObject({
      contextType: "worktree",
      path: "/home/u/.traycer/worktrees/o/r/feature",
      worktreePath: "/home/u/.traycer/worktrees/o/r/feature",
      branch: "feature",
      isMain: false,
    });
  });

  it("builds single-purpose host requests for root query and provider steps", () => {
    const rootRequests = mentionProviderRegistry.workspaceRequests(
      ROOT_MENTION_STEP,
      context({ query: "index" }),
    );
    expect(rootRequests.map((request) => request.method)).toEqual([
      "workspace.mentionFiles",
      "workspace.mentionFolders",
      "workspace.mentionWorktrees",
    ]);

    const epicRequests = mentionProviderRegistry.epicRequests(
      ROOT_MENTION_STEP,
      context({ query: "login" }),
    );
    expect(epicRequests.map((request) => request.method)).toEqual([
      "epic.mentionEpics",
      "epic.mentionSpecs",
      "epic.mentionTickets",
      "epic.mentionStories",
      "epic.mentionReviews",
    ]);

    const artifactStep: MentionFlowStep = {
      kind: "provider",
      providerId: "artifacts",
      stepId: "root",
      workspacePath: null,
    };
    expect(
      mentionProviderRegistry
        .epicRequests(artifactStep, context({ query: "login" }))
        .map((request) => request.method),
    ).toEqual([
      "epic.mentionSpecs",
      "epic.mentionTickets",
      "epic.mentionStories",
      "epic.mentionReviews",
    ]);
  });

  it("lists specs, tickets, stories, and reviews together while preserving mention types", () => {
    const artifactStep: MentionFlowStep = {
      kind: "provider",
      providerId: "artifacts",
      stepId: "root",
      workspacePath: null,
    };
    const entries = mentionProviderRegistry.entries(
      artifactStep,
      context({
        epicEntries: [
          {
            kind: "epic-artifact",
            id: "spec:epic-1:spec-1",
            token: "spec:epic-1/spec-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            artifactId: "spec-1",
            artifactType: "spec",
            label: "Auth spec",
            description: "Auth epic",
            status: null,
            updatedAt: 30,
          },
          {
            kind: "epic-artifact",
            id: "ticket:epic-1:ticket-1",
            token: "ticket:epic-1/ticket-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            artifactId: "ticket-1",
            artifactType: "ticket",
            label: "Auth ticket",
            description: "Auth epic",
            status: 1,
            updatedAt: 20,
          },
          {
            kind: "epic-artifact",
            id: "story:epic-1:story-1",
            token: "story:epic-1/story-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            artifactId: "story-1",
            artifactType: "story",
            label: "Auth story",
            description: "Auth epic",
            status: 0,
            updatedAt: 10,
          },
          {
            kind: "epic-artifact",
            id: "review:epic-1:review-1",
            token: "review:epic-1/review-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            artifactId: "review-1",
            artifactType: "review",
            label: "Auth review",
            description: "Auth epic",
            status: null,
            updatedAt: 5,
          },
        ],
      }),
    );

    expect(labels(entries)).toEqual([
      "Back",
      "Auth spec",
      "Auth ticket",
      "Auth story",
      "Auth review",
    ]);
    expect(completeEntry(entries[1]).contextType).toBe("spec");
    expect(completeEntry(entries[2]).contextType).toBe("ticket");
    expect(completeEntry(entries[3]).contextType).toBe("story");
    expect(completeEntry(entries[4]).contextType).toBe("review");
    expect(mentionProviderRegistry.menuCopy(artifactStep)).toEqual({
      header: "Artifacts",
      empty: "No artifacts available",
    });
  });

  it("scopes an Epic-attached root to searchPaths and keeps unattached roots legacy", () => {
    const requests = mentionProviderRegistry.workspaceRequests(
      ROOT_MENTION_STEP,
      context({
        query: "index",
        roots: ["/attached", "/global"],
        currentEpicId: "epic-1",
        epicAttachedRoots: new Set(["/attached"]),
      }),
    );
    const scoped = requests.filter(
      (request): request is MentionSearchPathsRequest =>
        request.method === "workspace.searchPaths",
    );
    // The attached root produces one scoped request per file/folder provider.
    expect(scoped).toHaveLength(2);
    for (const request of scoped) {
      expect(request.root).toBe("/attached");
      expect(request.params.epicId).toBe("epic-1");
      expect(request.params.limit).toBe(25);
      expect("root" in request.params.reference).toBe(true);
      if ("root" in request.params.reference) {
        expect(request.params.reference.root).toBe("/attached");
      }
    }
    expect(scoped.map((request) => request.method)).toEqual([
      "workspace.searchPaths",
      "workspace.searchPaths",
    ]);
    // Each provider requests exactly its own kind so folders are never starved
    // by files sharing the limit.
    expect(
      scoped.map((request) => ({
        kind: request.suggestionKind,
        kinds: request.params.kinds,
      })),
    ).toEqual([
      { kind: "file", kinds: "files" },
      { kind: "folder", kinds: "folders" },
    ]);

    // The unattached root keeps the legacy raw-root RPCs (files + folders).
    const legacyFileRoots = requests.flatMap((request) =>
      request.method === "workspace.mentionFiles" ? [request.params.roots] : [],
    );
    expect(legacyFileRoots).toEqual([["/global"]]);
    const legacyFolderRoots = requests.flatMap((request) =>
      request.method === "workspace.mentionFolders"
        ? [request.params.roots]
        : [],
    );
    expect(legacyFolderRoots).toEqual([["/global"]]);
  });

  it("emits no legacy file/folder request when every root is Epic-attached", () => {
    const requests = mentionProviderRegistry.workspaceRequests(
      ROOT_MENTION_STEP,
      context({
        query: "index",
        roots: ["/a", "/b"],
        currentEpicId: "epic-1",
        epicAttachedRoots: new Set(["/a", "/b"]),
      }),
    );
    expect(
      requests.some(
        (request) =>
          request.method === "workspace.mentionFiles" ||
          request.method === "workspace.mentionFolders",
      ),
    ).toBe(false);
    // Two roots x two providers (files + folders) = four scoped requests.
    expect(
      requests.filter((request) => request.method === "workspace.searchPaths"),
    ).toHaveLength(4);
  });

  it("uses only legacy RPCs when there is no current Epic, even with attached roots", () => {
    const requests = mentionProviderRegistry.workspaceRequests(
      ROOT_MENTION_STEP,
      context({
        query: "index",
        roots: ["/a"],
        currentEpicId: null,
        epicAttachedRoots: new Set(["/a"]),
      }),
    );
    expect(
      requests.some((request) => request.method === "workspace.searchPaths"),
    ).toBe(false);
    expect(requests.map((request) => request.method)).toEqual([
      "workspace.mentionFiles",
      "workspace.mentionFolders",
      "workspace.mentionWorktrees",
    ]);
  });

  it("keeps task and epic provider aliases backward-compatible for task requests", () => {
    expect(
      mentionProviderRegistry.epicRequests(
        ROOT_MENTION_STEP,
        context({ query: "task" }),
      )[0],
    ).toMatchObject({
      method: "epic.mentionEpics",
      params: { query: "" },
    });

    expect(
      mentionProviderRegistry.epicRequests(
        ROOT_MENTION_STEP,
        context({ query: "epic" }),
      )[0],
    ).toMatchObject({
      method: "epic.mentionEpics",
      params: { query: "" },
    });
  });
});

describe("mention preview payloads", () => {
  it("previews a file entry as a path breadcrumb tree with its absolute-path footer", () => {
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "files",
      stepId: "root",
      workspacePath: null,
    };
    const entries = mentionProviderRegistry.entries(
      step,
      context({
        workspaceEntries: [
          {
            kind: "file",
            id: "file:/repo:src/auth.ts",
            label: "auth.ts",
            relPath: "src/auth.ts",
            absolutePath: "/repo/src/auth.ts",
            workspacePath: "/repo",
            description: "src",
          },
        ],
      }),
    );
    expect(entries[1].preview).toEqual({
      kind: "path",
      tree: {
        rootLabel: "src",
        midDirs: [],
        leaf: "auth.ts",
        leafIsFile: true,
      },
      footer: { text: "/repo/src/auth.ts", mono: true },
    });
  });

  it("previews a folder entry as a path tree with leafIsFile: false", () => {
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "folders",
      stepId: "root",
      workspacePath: null,
    };
    const entries = mentionProviderRegistry.entries(
      step,
      context({
        workspaceEntries: [
          {
            kind: "folder",
            id: "folder:/repo:src/auth/",
            label: "auth",
            relPath: "src/auth/",
            absolutePath: "/repo/src/auth",
            workspacePath: "/repo",
            description: "src",
          },
        ],
      }),
    );
    expect(entries[1].preview).toEqual({
      kind: "path",
      tree: {
        rootLabel: "src",
        midDirs: [],
        leaf: "auth",
        leafIsFile: false,
      },
      footer: { text: "/repo/src/auth", mono: true },
    });
  });

  it("previews a worktree entry as a path tree built from its absolute path, with the branch as footer", () => {
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "worktree",
      stepId: "root",
      workspacePath: null,
    };
    const entries = mentionProviderRegistry.entries(
      step,
      context({
        workspaceEntries: [
          {
            kind: "worktree",
            id: "worktree:/repo:/home/u/.traycer/worktrees/o/r/feature",
            label: "feature",
            worktreePath: "/home/u/.traycer/worktrees/o/r/feature",
            workspacePath: "/repo",
            branch: "feature",
            isMain: false,
            description: "/home/u/.traycer/worktrees/o/r/feature",
          },
        ],
      }),
    );
    expect(entries[1].preview).toEqual({
      kind: "path",
      tree: {
        rootLabel: "/home/u/.traycer/worktrees",
        midDirs: ["o", "r"],
        leaf: "feature",
        leafIsFile: false,
      },
      footer: { text: "feature", mono: false },
    });
  });

  it("previews a detached worktree (no branch) with no footer, not a duplicated path", () => {
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "worktree",
      stepId: "root",
      workspacePath: null,
    };
    const entries = mentionProviderRegistry.entries(
      step,
      context({
        workspaceEntries: [
          {
            kind: "worktree",
            id: "worktree:/repo:/home/u/.traycer/worktrees/o/r/detached",
            label: "detached",
            worktreePath: "/home/u/.traycer/worktrees/o/r/detached",
            workspacePath: "/repo",
            branch: null,
            isMain: false,
            description: "/home/u/.traycer/worktrees/o/r/detached",
          },
        ],
      }),
    );
    expect(entries[1].preview).toMatchObject({ kind: "path", footer: null });
  });

  it("previews an artifact entry with its full title and parent epic title", () => {
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "artifacts",
      stepId: "root",
      workspacePath: null,
    };
    const entries = mentionProviderRegistry.entries(
      step,
      context({
        epicEntries: [
          {
            kind: "epic-artifact",
            id: "spec:epic-1:spec-1",
            token: "spec:epic-1/spec-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            artifactId: "spec-1",
            artifactType: "spec",
            label: "Auth spec",
            description: "Auth epic",
            status: null,
            updatedAt: 20,
          },
        ],
      }),
    );
    expect(entries[1].preview).toEqual({
      kind: "text",
      primary: "Auth spec",
      secondary: "Auth epic",
      mono: false,
    });
  });

  it("previews an Agent entry with its interface and delivery capability, not the epic title", () => {
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "chat",
      stepId: "root",
      workspacePath: null,
    };
    const entries = mentionProviderRegistry.entries(
      step,
      context({
        currentEpicId: "epic-1",
        agentEntries: [
          terminalAgent({
            terminalAgentId: "tui-1",
            label: "Codex run",
            harnessId: "codex",
            runtimeSupportsMessageDelivery: false,
            updatedAt: 20,
          }),
          chatAgent("chat-1", "Kickoff", 10),
        ],
      }),
    );

    expect(entries[1].preview).toEqual({
      kind: "text",
      primary: "Codex run",
      secondary: "Terminal · Codex · Reference only",
      mono: false,
    });
    expect(entries[2].preview).toEqual({
      kind: "text",
      primary: "Kickoff",
      secondary: "Chat",
      mono: false,
    });
  });

  it("previews a git commit entry with its full hash and derived subject", () => {
    const step: MentionFlowStep = {
      kind: "provider",
      providerId: "git",
      stepId: "commits",
      workspacePath: "/repo",
    };
    const entries = mentionProviderRegistry.entries(
      step,
      context({
        workspaceEntries: [
          {
            kind: "git",
            id: "git:commit:/repo:abc1234567890",
            label: "abc1234 Fix bug in parser",
            description: "Jane Doe - 2024-01-01 - repo",
            workspacePath: "/repo",
            gitType: "against_commit",
            branchName: null,
            commitHash: "abc1234567890",
          },
        ],
      }),
    );
    expect(entries[1].preview).toEqual({
      kind: "text",
      primary: "abc1234567890",
      secondary: "Fix bug in parser",
      mono: true,
    });
  });
});

/**
 * `rootEntries` ranks a URL-shaped query through `rootRankingQuery`, which
 * rewrites it to the `owner/repo#123` reference form the row's `description`
 * actually carries - host-prefixed off github.com, folded the same way
 * `referenceMatchesRow` folds a pasted `https://GitHub.com/...` spelling. The
 * raw URL string matches nothing any row carries, so without the rewrite a
 * coincidental fuzzy hit elsewhere could outrank the exact row the URL names.
 */
describe("pasted-URL root ranking", () => {
  function pullRequestRow(fields: {
    readonly githubHost: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly title: string;
  }): GithubMentionRow {
    return {
      kind: "pull-request",
      githubHost: fields.githubHost,
      owner: fields.owner,
      repo: fields.repo,
      number: fields.number,
      title: fields.title,
      url: `https://${fields.githubHost}/${fields.owner}/${fields.repo}/pull/${fields.number}`,
      author: null,
      updatedAt: 1_000,
      buckets: ["recent"],
      state: "open",
      isDraft: false,
      baseRefName: null,
      headRefName: null,
      reviewDecision: null,
      checksRollup: null,
    };
  }

  /**
   * A file whose path spells out "github.com" - a coincidental substring
   * match against the raw pasted URL that could out-rank the exact row if
   * the ranking query were never rewritten off the URL text.
   */
  function competingFileEntry() {
    return {
      kind: "file" as const,
      id: "file:/repo:docs/github.com-integration-notes.md",
      label: "github.com-integration-notes.md",
      relPath: "docs/github.com-integration-notes.md",
      absolutePath: "/repo/docs/github.com-integration-notes.md",
      workspacePath: "/repo",
      description: "docs",
    };
  }

  it("ranks the row a pasted GitHub URL names first, ahead of a coincidental path match", () => {
    const row = pullRequestRow({
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      number: 123,
      title: "Some title",
    });

    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        query: "https://github.com/acme/widgets/pull/123",
        workspaceEntries: [competingFileEntry()],
        github: {
          pullRequests: {
            rows: [row],
            rowsHeld: false,
            repositories: [
              { githubHost: "github.com", owner: "acme", repo: "widgets" },
            ],
          },
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: true,
          now: 0,
        },
      }),
    );

    expect(entries[0].label).toBe("Some title");
  });

  it("ranks the same row first when the pasted URL's host is cased differently", () => {
    // `GitHub.com` folds to the default host exactly like `github.com`, so the
    // rewritten ranking query omits the host segment either way.
    const row = pullRequestRow({
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      number: 123,
      title: "Some title",
    });

    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        query: "https://GitHub.com/acme/widgets/pull/123",
        workspaceEntries: [competingFileEntry()],
        github: {
          pullRequests: {
            rows: [row],
            rowsHeld: false,
            repositories: [
              { githubHost: "github.com", owner: "acme", repo: "widgets" },
            ],
          },
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: true,
          now: 0,
        },
      }),
    );

    expect(entries[0].label).toBe("Some title");
  });

  it("ranks an enterprise-host row first for a pasted URL on that host", () => {
    // A non-default host is NOT omitted from the rewritten query, so the row
    // must actually carry that host segment in its description to still win.
    // The competing file's path echoes the enterprise host's URL text
    // itself, so it stays a real competitor for the unrewritten raw URL.
    const row = pullRequestRow({
      githubHost: "ghe.corp",
      owner: "acme",
      repo: "widgets",
      number: 123,
      title: "Enterprise title",
    });
    const competingEnterpriseFileEntry = {
      kind: "file" as const,
      id: "file:/repo:docs/ghe.corp-acme-widgets-notes.md",
      label: "ghe.corp-acme-widgets-notes.md",
      relPath: "docs/ghe.corp-acme-widgets-notes.md",
      absolutePath: "/repo/docs/ghe.corp-acme-widgets-notes.md",
      workspacePath: "/repo",
      description: "docs",
    };

    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        query: "https://ghe.corp/acme/widgets/pull/123",
        workspaceEntries: [competingEnterpriseFileEntry],
        github: {
          pullRequests: {
            rows: [row],
            rowsHeld: false,
            repositories: [
              { githubHost: "ghe.corp", owner: "acme", repo: "widgets" },
            ],
          },
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: true,
          now: 0,
        },
      }),
    );

    expect(entries[0].label).toBe("Enterprise title");
  });

  it("leaves a non-reference prose query's ranking unaffected", () => {
    // The control: `parseGithubReferenceQuery` returns null for prose, so
    // `rootRankingQuery` hands the query straight through and ranking works
    // exactly as it always has - matching on what the row actually says.
    const row = pullRequestRow({
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      number: 123,
      title: "Some title",
    });

    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        query: "some title",
        workspaceEntries: [competingFileEntry()],
        github: {
          pullRequests: {
            rows: [row],
            rowsHeld: false,
            repositories: [
              { githubHost: "github.com", owner: "acme", repo: "widgets" },
            ],
          },
          issues: EMPTY_GITHUB_SECTION_CONTEXT,
          supported: true,
          now: 0,
        },
      }),
    );

    expect(entries[0].label).toBe("Some title");
  });
});

/**
 * The zero-match reference exemption in `use-mention-items.ts` gates on this
 * SAME predicate rather than a hand-written twin - a restated copy is how
 * `@#123` once pinned the picker open over a category that contributes no
 * rows. Direct unit coverage on both terms, independent of the registry
 * plumbing above.
 */
describe("githubMentionCategoryAvailable", () => {
  it("is available when the host serves the mention methods and there is at least one root", () => {
    expect(githubMentionCategoryAvailable(true, 1)).toBe(true);
  });

  it("is unavailable when the host does not serve the mention methods, even with roots", () => {
    expect(githubMentionCategoryAvailable(false, 1)).toBe(false);
  });

  it("is unavailable with no roots to scope to, even on a supporting host", () => {
    expect(githubMentionCategoryAvailable(true, 0)).toBe(false);
  });
});

describe("Browser mention category", () => {
  it("is hidden at root when there are no browser tabs", () => {
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({ browserTabEntries: [] }),
    );
    expect(labels(entries)).not.toContain("Browser");
  });

  it("lists every tab flat across sessions, co-located tab ranked first", () => {
    const browserTabEntries = [
      browserTab({
        tabId: "tab-old",
        sessionId: "session-1",
        label: "Docs",
        url: "https://docs.example.com",
        coLocated: false,
        lastActivityAt: 100,
        dormant: false,
      }),
      browserTab({
        tabId: "tab-new",
        sessionId: "session-2",
        label: "Issue tracker",
        url: "https://issues.example.com",
        coLocated: false,
        lastActivityAt: 200,
        dormant: false,
      }),
      browserTab({
        tabId: "tab-viewed",
        sessionId: "session-2",
        label: "Dashboard",
        url: "https://dash.example.com",
        coLocated: true,
        lastActivityAt: 50,
        dormant: false,
      }),
    ];
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({ currentEpicId: "epic-1", browserTabEntries }),
    );
    expect(labels(entries)).toContain("Browser");

    const rows = mentionProviderRegistry.entries(
      navigateEntry(entryByLabel(entries, "Browser")),
      context({ currentEpicId: "epic-1", browserTabEntries }),
    );
    // Back row, then co-located first, then the rest by session recency.
    expect(labels(rows)).toEqual([
      "Back",
      "Dashboard",
      "Issue tracker",
      "Docs",
    ]);
  });

  it("demotes a dormant tab below a live tab of equal match quality and co-location, but a more recent dormant tab still beats an older live one", () => {
    const browserTabEntries = [
      browserTab({
        tabId: "tab-dormant-newer",
        sessionId: "session-1",
        label: "Docs",
        url: "https://docs.example.com",
        coLocated: false,
        lastActivityAt: 500,
        dormant: true,
      }),
      browserTab({
        tabId: "tab-live-older",
        sessionId: "session-2",
        label: "Notes",
        url: "https://notes.example.com",
        coLocated: false,
        lastActivityAt: 10,
        dormant: false,
      }),
    ];
    const rows = mentionProviderRegistry.entries(
      {
        kind: "provider",
        providerId: "browser-tab",
        stepId: "root",
        workspacePath: null,
      },
      context({ currentEpicId: "epic-1", browserTabEntries }),
    );
    // Dormancy is a tiebreak, not an override: it only applies among rows
    // already equal on match quality and coLocated. With no query, every row
    // scores 0, so the live tab sorts first despite being far less recent.
    expect(labels(rows)).toEqual(["Back", "Notes", "Docs"]);
  });

  it("root search matches a tab's url as well as its title", () => {
    const browserTabEntries = [
      browserTab({
        tabId: "tab-1",
        sessionId: "session-1",
        label: "Home",
        url: "https://example.com/pricing",
        coLocated: false,
        lastActivityAt: 1,
        dormant: false,
      }),
    ];
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({ query: "pricing", browserTabEntries }),
    );
    expect(labels(entries)).toContain("Home");
  });

  it("completing a row builds a browser-tab mention keyed by the durable tabId", () => {
    const browserTabEntries = [
      browserTab({
        tabId: "tab-1",
        sessionId: "session-1",
        label: "Home",
        url: "https://example.com",
        coLocated: false,
        lastActivityAt: 1,
        dormant: false,
      }),
    ];
    const rows = mentionProviderRegistry.entries(
      {
        kind: "provider",
        providerId: "browser-tab",
        stepId: "root",
        workspacePath: null,
      },
      context({ browserTabEntries }),
    );
    expect(completeEntry(entryByLabel(rows, "Home"))).toEqual({
      kind: "mention",
      contextType: "browser-tab",
      path: "browser-tab:tab-1",
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: "Home",
      // Dead field for this variant - kept only because `MentionAttachment`
      // requires it on every member (see FIX 3/CLEANUP 4 in
      // chat-user-message-content.tsx / attachments.ts).
      description: "",
      tabId: "tab-1",
      sessionId: "session-1",
      url: "https://example.com",
    });
  });
});
