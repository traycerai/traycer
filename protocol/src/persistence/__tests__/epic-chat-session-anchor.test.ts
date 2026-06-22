import { describe, expect, it } from "vitest";
import { chatSessionAnchorSchema } from "@traycer/protocol/persistence/epic/schemas";

describe("chatSessionAnchorSchema", () => {
  it("accepts OpenCode session anchors with hostId", () => {
    expect(
      chatSessionAnchorSchema.parse({
        harnessId: "opencode",
        hostId: "host-1",
        sessionId: "ses_1",
        sessionWorkspaceSnapshot: {
          workspaceKind: "session-snapshot",
          primaryWorkspace: "/repo",
          secondaryWorkspaces: [],
        },
        opencodeUserMessageId: "msg_1",
        createdAt: 1,
      }),
    ).toMatchObject({
      harnessId: "opencode",
      hostId: "host-1",
      sessionId: "ses_1",
      opencodeUserMessageId: "msg_1",
    });
  });

  it("discriminates Claude session anchors on harnessId", () => {
    expect(
      chatSessionAnchorSchema.parse({
        harnessId: "claude",
        hostId: "host-1",
        sessionId: "ses_1",
        sessionWorkspaceSnapshot: {
          workspaceKind: "session-snapshot",
          primaryWorkspace: "/repo",
          secondaryWorkspaces: [],
        },
        claudeMessageUuid: "uuid-1",
        createdAt: 1,
      }),
    ).toMatchObject({
      harnessId: "claude",
      hostId: "host-1",
      claudeMessageUuid: "uuid-1",
    });
  });

  it("accepts Codex session anchors with workspace association", () => {
    expect(
      chatSessionAnchorSchema.parse({
        harnessId: "codex",
        hostId: "host-1",
        sessionId: "thread-1",
        sessionWorkspaceSnapshot: {
          workspaceKind: "session-snapshot",
          primaryWorkspace: "/repo",
          secondaryWorkspaces: [],
        },
        codexTurnId: "turn-1",
        codexUserMessageId: "user-1",
        createdAt: 1,
      }),
    ).toMatchObject({
      harnessId: "codex",
      hostId: "host-1",
      sessionId: "thread-1",
      sessionWorkspaceSnapshot: {
        workspaceKind: "session-snapshot",
        primaryWorkspace: "/repo",
        secondaryWorkspaces: [],
      },
      codexTurnId: "turn-1",
      codexUserMessageId: "user-1",
    });
  });

  it("accepts Cursor session anchors with optional run identity", () => {
    expect(
      chatSessionAnchorSchema.parse({
        harnessId: "cursor",
        hostId: "host-1",
        sessionId: "agent_1",
        sessionWorkspaceSnapshot: {
          workspaceKind: "session-snapshot",
          primaryWorkspace: "/repo",
          secondaryWorkspaces: [],
        },
        cursorRunId: null,
        createdAt: 1,
      }),
    ).toMatchObject({
      harnessId: "cursor",
      hostId: "host-1",
      sessionId: "agent_1",
      cursorRunId: null,
    });
  });
});
