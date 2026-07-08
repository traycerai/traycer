import { describe, expect, it } from "vitest";
import type {
  ComposerMentionProviderContext,
  MentionFlowStep,
  MentionMenuEntry,
} from "../providers";
import { mentionProviderRegistry, ROOT_MENTION_STEP } from "../providers";

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
    chatEntries: [],
    ...overrides,
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
      "Task",
      "Spec",
      "Ticket",
      "Story",
      "Review",
    ]);
  });

  it("adds chat as a current-epic provider", () => {
    const entries = mentionProviderRegistry.entries(
      ROOT_MENTION_STEP,
      context({
        currentEpicId: "epic-1",
        chatEntries: [
          {
            kind: "epic-chat",
            id: "chat:epic-1:chat-1",
            token: "chat:epic-1/chat-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            chatId: "chat-1",
            label: "Kickoff chat",
            description: "Auth epic",
            parentId: null,
            updatedAt: 10,
          },
        ],
      }),
    );

    expect(labels(entries)).toEqual([
      "Files",
      "Folders",
      "Worktrees",
      "Git",
      "Task",
      "Chat",
      "Spec",
      "Ticket",
      "Story",
      "Review",
    ]);

    const chatRows = mentionProviderRegistry.entries(
      navigateEntry(entries[5]),
      context({
        currentEpicId: "epic-1",
        chatEntries: [
          {
            kind: "epic-chat",
            id: "chat:epic-1:chat-1",
            token: "chat:epic-1/chat-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            chatId: "chat-1",
            label: "Kickoff chat",
            description: "Auth epic",
            parentId: null,
            updatedAt: 10,
          },
        ],
      }),
    );

    expect(labels(chatRows)).toEqual(["Back", "Kickoff chat"]);
    expect(completeEntry(chatRows[1])).toMatchObject({
      contextType: "chat",
      path: "chat:epic-1/chat-1",
      epicId: "epic-1",
      chatId: "chat-1",
    });
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
        chatEntries: [
          {
            kind: "epic-chat",
            id: "chat:epic-1:chat-1",
            token: "chat:epic-1/chat-1",
            epicId: "epic-1",
            epicTitle: "Auth epic",
            chatId: "chat-1",
            label: "Auth chat",
            description: "Auth epic",
            parentId: null,
            updatedAt: 20,
          },
        ],
        currentEpicId: "epic-1",
      }),
    );

    expect(labels(entries)).toEqual([
      "auth.ts",
      "auth",
      "Auth epic",
      "Auth chat",
      "Auth spec",
    ]);
    expect(completeEntry(entries[3])).toMatchObject({
      contextType: "chat",
      path: "chat:epic-1/chat-1",
    });
    expect(completeEntry(entries[4])).toMatchObject({
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
      providerId: "spec",
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
