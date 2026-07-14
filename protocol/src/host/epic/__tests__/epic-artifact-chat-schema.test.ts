import { describe, expect, it } from "vitest";
import {
  createArtifactRequestSchema,
  createChatRequestSchema,
  updateArtifactStatusRequestSchema,
  userInviteGrantSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

describe("createArtifactRequestSchema", () => {
  it("accepts the locked minimal shape", () => {
    const result = createArtifactRequestSchema.safeParse({
      epicId: "e1",
      parentId: null,
      artifactType: "spec",
      title: "My spec",
    });
    expect(result.success).toBe(true);
  });

  it("rejects the old 'kind' field name", () => {
    const result = createArtifactRequestSchema.safeParse({
      epicId: "e1",
      kind: "spec",
      title: "My spec",
    });
    expect(result.success).toBe(false);
  });

  it("requires parentId", () => {
    const result = createArtifactRequestSchema.safeParse({
      epicId: "e1",
      artifactType: "spec",
      title: "My spec",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateArtifactStatusRequestSchema", () => {
  it("accepts artifactType: 'ticket'", () => {
    const result = updateArtifactStatusRequestSchema.safeParse({
      epicId: "e1",
      artifactId: "a1",
      artifactType: "ticket",
      status: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts artifactType: 'story'", () => {
    const result = updateArtifactStatusRequestSchema.safeParse({
      epicId: "e1",
      artifactId: "a1",
      artifactType: "story",
      status: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects old 'artifactKind' field name", () => {
    const result = updateArtifactStatusRequestSchema.safeParse({
      epicId: "e1",
      artifactId: "a1",
      artifactKind: "ticket",
      status: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects artifactType: 'spec' (only ticket|story allowed)", () => {
    const result = updateArtifactStatusRequestSchema.safeParse({
      epicId: "e1",
      artifactId: "a1",
      artifactType: "spec",
      status: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("createChatRequestSchema", () => {
  it("accepts the locked minimal shape", () => {
    const result = createChatRequestSchema.safeParse({
      epicId: "e1",
      parentId: null,
      hostId: "d1",
      title: "New chat",
      chatId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("rejects bare { epicId } without required fields", () => {
    const result = createChatRequestSchema.safeParse({ epicId: "e1" });
    expect(result.success).toBe(false);
  });

  it("accepts forkSource with an assistant message id", () => {
    const result = createChatRequestSchema.safeParse({
      epicId: "e1",
      parentId: null,
      hostId: "d1",
      title: "Forked chat",
      chatId: "11111111-1111-4111-8111-111111111111",
      forkSource: {
        sourceChatId: "source-chat-1",
        assistantMessageId: "assistant-message-1",
        interviewBlockId: "question-tool:interview",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects forkSource with the old assistant turn key field", () => {
    const result = createChatRequestSchema.safeParse({
      epicId: "e1",
      parentId: null,
      hostId: "d1",
      title: "Forked chat",
      chatId: "11111111-1111-4111-8111-111111111111",
      forkSource: {
        sourceChatId: "source-chat-1",
        assistantTurnKey: "turn-1",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("userInviteGrantSchema", () => {
  it("accepts 'invites' field", () => {
    const result = userInviteGrantSchema.safeParse({
      invites: [
        { identifier: "a@b.com", identifierType: "email", role: "editor" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects old 'entries' field name", () => {
    const result = userInviteGrantSchema.safeParse({
      entries: [
        { identifier: "a@b.com", identifierType: "email", role: "editor" },
      ],
    });
    expect(result.success).toBe(false);
  });
});
