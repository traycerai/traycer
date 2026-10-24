import { describe, expect, it } from "vitest";
import {
  agentGuiListCommandsV11,
  agentGuiListCommandsV12,
  agentGuiListModelsV10,
  agentGuiListModelsV11,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  epicCreateChatV12,
  epicCreateChatV13,
} from "@traycer/protocol/host/epic/contracts";
import {
  providersSetSelectionV10,
  providersSetSelectionV21,
  providersSetSelectionV22,
} from "@traycer/protocol/host/registry";
import { chatSchema } from "@traycer/protocol/persistence/epic/chat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { z } from "zod";

/**
 * The OpenCode line on the wire: each new optional key is kept by the minor
 * that introduces it and stripped by the older minor's request schema, which
 * is the schema a within-major re-parse for an older host binds.
 */

describe("providers.setSelection line", () => {
  const request = {
    providerId: "opencode",
    selection: { kind: "bundled", line: 1 },
  };

  it("keeps line on the bundled arm at 2.2", () => {
    expect(providersSetSelectionV22.requestSchema.parse(request)).toEqual(
      request,
    );
  });

  it.each([
    ["2.1", providersSetSelectionV21],
    ["1.0", providersSetSelectionV10],
  ])("strips line at %s", (_label, contract) => {
    expect(contract.requestSchema.parse(request).selection).toEqual({
      kind: "bundled",
    });
  });

  it("rejects a line outside 1 and 2", () => {
    expect(
      providersSetSelectionV22.requestSchema.safeParse({
        ...request,
        selection: { kind: "bundled", line: 3 },
      }).success,
    ).toBe(false);
  });
});

describe("providers.setSelection echo", () => {
  const response = {
    state: {
      providerId: "opencode",
      enabled: true,
      disabledBy: null,
      selected: { kind: "bundled", line: 1 },
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
    },
  };

  it("echoes the chosen line at 2.2", () => {
    expect(
      providersSetSelectionV22.responseSchema.parse(response).state.selected,
    ).toEqual({ kind: "bundled", line: 1 });
  });

  it("strips it at 2.1", () => {
    expect(
      providersSetSelectionV21.responseSchema.parse(response).state.selected,
    ).toEqual({ kind: "bundled" });
  });
});

describe("epic.createChat opencodeLine", () => {
  const request = {
    epicId: "epic-1",
    chatId: "chat-1",
    parentId: null,
    hostId: "host-1",
    title: "Chat",
    worktreeIntent: null,
    opencodeLine: 2,
  };

  it("keeps opencodeLine at 1.3", () => {
    const parsed = epicCreateChatV13.requestSchema.parse(request);
    expect(parsed.opencodeLine).toBe(2);
  });

  it("strips opencodeLine at 1.2", () => {
    const parsed = epicCreateChatV12.requestSchema.parse(request);
    expect(Object.hasOwn(parsed, "opencodeLine")).toBe(false);
    expect(parsed.chatId).toBe("chat-1");
  });
});

describe("agent.gui catalog opencodeLine", () => {
  const models = {
    harnessId: "opencode",
    workingDirectory: "/work",
    opencodeLine: 2,
  };

  it("listModels@1.1 keeps it and 1.0 strips it", () => {
    expect(agentGuiListModelsV11.requestSchema.parse(models)).toMatchObject({
      opencodeLine: 2,
    });
    expect(
      Object.hasOwn(
        agentGuiListModelsV10.requestSchema.parse(models),
        "opencodeLine",
      ),
    ).toBe(false);
  });

  it("listCommands@1.2 keeps it and 1.1 strips it", () => {
    expect(agentGuiListCommandsV12.requestSchema.parse(models)).toMatchObject({
      opencodeLine: 2,
    });
    expect(
      Object.hasOwn(
        agentGuiListCommandsV11.requestSchema.parse(models),
        "opencodeLine",
      ),
    ).toBe(false);
  });
});

describe("chat record opencodeLine", () => {
  const base = {
    parentId: null,
    id: "chat-1",
    userId: "user-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1000,
    updatedAt: 1000,
    isTitleEditedByUser: false,
    messages: [],
  };

  it.each([1, 2] as const)(
    "parses line %s and leaves absent as absent",
    (line) => {
      expect(
        chatSchema.parse({ ...base, opencodeLine: line }).opencodeLine,
      ).toBe(line);
      expect(Object.hasOwn(chatSchema.parse(base), "opencodeLine")).toBe(false);
    },
  );

  it("rejects line 3", () => {
    expect(chatSchema.safeParse({ ...base, opencodeLine: 3 }).success).toBe(
      false,
    );
  });

  it("rides chat.subscribe from 1.23 on, and no frozen line below", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    const text = (minor: number): string => {
      const version = line.versions[minor];
      if (version === undefined)
        throw new Error(`no chat.subscribe@1.${minor}`);
      return (["input", "output"] as const)
        .map((io) =>
          JSON.stringify(
            z.toJSONSchema(version.contract.serverFrameSchema, {
              io,
              unrepresentable: "any",
            }),
          ),
        )
        .join("\n");
    };
    expect(text(22)).not.toContain('"opencodeLine":');
    expect(text(13)).not.toContain('"opencodeLine":');
    expect(text(23)).toContain('"opencodeLine":');
    expect(text(34)).toContain('"opencodeLine":');
  });
});
