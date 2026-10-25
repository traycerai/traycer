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
  hostRpcRegistry,
  providersSetSelectionV10,
  providersSetSelectionV21,
  providersSetSelectionV22,
} from "@traycer/protocol/host/registry";
import { providerCliStateSchema } from "@traycer/protocol/host/provider-schemas";
import { chatSchema } from "@traycer/protocol/persistence/epic/chat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("providers.setSelection@2.3", () => {
  const request = {
    providerId: "opencode",
    selection: { kind: "bundled", line: 1 },
  };
  const entry = hostRpcRegistry["providers.setSelection"][2];

  const version = {
    2: (): (typeof entry.versions)[2]["contract"] => entry.versions[2].contract,
    3: (): (typeof entry.versions)[3]["contract"] => entry.versions[3].contract,
  } as const;

  it("registers 2.3 above 2.2 and keeps the named line unchanged", () => {
    expect(entry.latestMinor).toBe(3);
    const head = version[3]();
    expect(head).not.toBe(version[2]());
    expect(head.schemaVersion).toEqual({ major: 2, minor: 3 });
    expect(head.requestSchema.parse(request)).toEqual(request);
  });

  it("answers with the same response as 2.2", () => {
    const response = {
      state: {
        providerId: "opencode",
        enabled: true,
        disabledBy: null,
        selected: { kind: "bundled", line: 2 },
        candidates: [],
        auth: {
          status: "unknown",
          badgeText: null,
          label: null,
          detail: null,
        },
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
    expect(version[3]().responseSchema.parse(response)).toEqual(
      providersSetSelectionV22.responseSchema.parse(response),
    );
    expect(version[3]().responseSchema.parse(response).state.selected).toEqual({
      kind: "bundled",
      line: 2,
    });
  });

  it("strips line on the downgrade from the head to 1.0", () => {
    const downgrade = entry.downgradePathsFromLatest[1];
    expect(downgrade.from).toEqual({ major: 2, minor: 3 });
    const result = downgrade.downgradeRequest(
      version[3]().requestSchema.parse(request),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selection).toEqual({ kind: "bundled" });
  });
});

describe("chat.subscribe@1.38 opencodeLineHeld", () => {
  const line = hostStreamRpcRegistry["chat.subscribe"][1];

  function serverFrameSchema(minor: number) {
    const found = Object.entries(line.versions).find(
      ([key]) => Number(key) === minor,
    )?.[1];
    if (found === undefined) throw new Error(`no chat.subscribe@1.${minor}`);
    return found.contract.serverFrameSchema;
  }

  function snapshotFrame(held: unknown): Record<string, unknown> {
    return {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: {
          parentId: null,
          id: "chat-1",
          userId: "user-1",
          hostId: "host-1",
          title: "Chat",
          createdAt: 1000,
          updatedAt: 1000,
          isTitleEditedByUser: false,
        },
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: "idle",
        activeTurn: null,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChangeCount: 0,
        transcriptEpoch: 0,
        rowCount: 0,
        indexRevision: null,
        sendWouldQueue: true,
        tail: { fromOrdinal: 0, messages: [], events: [] },
        derived: {
          latestAssistantUsage: null,
          pinnedTodo: null,
          pinnedTaskTodoItems: [],
          latestForkableAssistantMessageId: null,
          restorableSetupInterruption: null,
          interviewAnswerability: [],
          latestAssistantAuthFailureTurnKey: null,
          setupCardWindows: [],
        },
        ...(held === undefined ? {} : { opencodeLineHeld: held }),
      },
    };
  }

  function snapshotOf(minor: number, held: unknown): Record<string, unknown> {
    const parsed: unknown = serverFrameSchema(minor).parse(snapshotFrame(held));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("frame did not parse to an object");
    }
    const snapshot: unknown = Object.fromEntries(
      Object.entries(parsed),
    ).snapshot;
    if (typeof snapshot !== "object" || snapshot === null) {
      throw new Error("frame carried no snapshot");
    }
    return Object.fromEntries(Object.entries(snapshot));
  }

  it.each([
    ["background_work", 1],
    ["model_unavailable", 2],
    ["binary_unavailable", 1],
  ] as const)(
    "keeps a %s hold on line %s at 1.38, and 1.37 drops it",
    (reason, heldLine) => {
      const held = { line: heldLine, reason };
      expect(snapshotOf(38, held).opencodeLineHeld).toEqual(held);
      expect(snapshotOf(37, held)).not.toHaveProperty("opencodeLineHeld");
    },
  );

  it("leaves the key absent when the host sent none", () => {
    expect(snapshotOf(38, undefined)).not.toHaveProperty("opencodeLineHeld");
  });

  it.each([
    ["a reason outside the three", { line: 1, reason: "because" }],
    ["a line of 3", { line: 3, reason: "background_work" }],
  ])("refuses %s at 1.38", (_label, held) => {
    expect(serverFrameSchema(38).safeParse(snapshotFrame(held)).success).toBe(
      false,
    );
  });
});

describe("providers.list@10.7 chatsFollow", () => {
  const row = {
    providerId: "cursor",
    enabled: true,
    disabledBy: null,
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
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
    },
    chatsFollow: true,
  };
  const entry = hostRpcRegistry["providers.list"][10];

  const listContract = {
    6: (): (typeof entry.versions)[6]["contract"] => entry.versions[6].contract,
    7: (): (typeof entry.versions)[7]["contract"] => entry.versions[7].contract,
  } as const;

  it("keeps the row's chatsFollow at 10.7 and strips it at 10.6", () => {
    expect(
      listContract[7]().responseSchema.parse({ providers: [row] }).providers[0]
        ?.chatsFollow,
    ).toBe(true);
    const older = listContract[6]().responseSchema.parse({ providers: [row] })
      .providers[0];
    expect(older).toBeDefined();
    expect(older).not.toHaveProperty("chatsFollow");
  });

  it("keeps the row and drops the key on the 1.0 downgrade", () => {
    const response = listContract[7]().responseSchema.parse({
      providers: [row],
    });
    expect(response.providers[0]).toHaveProperty("chatsFollow", true);
    const result =
      entry.downgradePathsFromLatest[1].downgradeResponse(response);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers).toHaveLength(1);
    expect(result.value.providers[0]?.providerId).toBe("cursor");
    expect(result.value.providers[0]).not.toHaveProperty("chatsFollow");
  });

  it("reads a row without the key as absent", () => {
    const { chatsFollow: _chatsFollow, ...bare } = row;
    expect(providerCliStateSchema.parse(bare)).not.toHaveProperty(
      "chatsFollow",
    );
  });
});

/**
 * The released lines never see the three new keys: the canonical line of each
 * method in the released baseline names none of them, in its request, response
 * or frames. A new key reaching a released line would be growth a shipped peer
 * cannot read.
 */
describe("released lines hold back the chats-follow keys", () => {
  const baseline: unknown = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "__fixtures__/released-baseline-surface.json"),
      "utf8",
    ),
  );

  function releasedCanonical(
    kind: "unary" | "stream",
    method: string,
  ): { readonly major: number; readonly minor: number } {
    const parsed = z
      .object({
        unary: z.record(
          z.string(),
          z.object({
            canonical: z.object({ major: z.number(), minor: z.number() }),
          }),
        ),
        stream: z.record(
          z.string(),
          z.object({
            canonical: z.object({ major: z.number(), minor: z.number() }),
          }),
        ),
      })
      .parse(baseline);
    const entry = parsed[kind][method];
    if (entry === undefined) throw new Error(`${method} is not released`);
    return entry.canonical;
  }

  function schemaText(schemas: readonly z.ZodType[]): string {
    return schemas
      .flatMap((schema) =>
        (["input", "output"] as const).map((io) =>
          JSON.stringify(
            z.toJSONSchema(schema, { io, unrepresentable: "any" }),
          ),
        ),
      )
      .join("\n");
  }

  it("providers.setSelection's released line takes no line on the selection", () => {
    const { major, minor } = releasedCanonical(
      "unary",
      "providers.setSelection",
    );
    expect({ major, minor }).toEqual({ major: 2, minor: 1 });
    const contract =
      hostRpcRegistry["providers.setSelection"][2].versions[1].contract;
    expect(
      contract.requestSchema.parse({
        providerId: "opencode",
        selection: { kind: "bundled", line: 2 },
      }).selection,
    ).toEqual({ kind: "bundled" });
  });

  it("providers.list's released line names no chatsFollow", () => {
    const { major, minor } = releasedCanonical("unary", "providers.list");
    const line = hostRpcRegistry["providers.list"][10];
    expect(major).toBe(10);
    const version = Object.entries(line.versions).find(
      ([key]) => Number(key) === minor,
    )?.[1];
    if (version === undefined) throw new Error(`no providers.list@10.${minor}`);
    expect(schemaText([version.contract.responseSchema])).not.toContain(
      '"chatsFollow":',
    );
  });

  it("chat.subscribe's released line names no opencodeLineHeld", () => {
    const { major, minor } = releasedCanonical("stream", "chat.subscribe");
    expect(major).toBe(1);
    const version = hostStreamRpcRegistry["chat.subscribe"][1].versions[minor];
    if (version === undefined) throw new Error(`no chat.subscribe@1.${minor}`);
    expect(
      schemaText([
        version.contract.serverFrameSchema,
        version.contract.clientFrameSchema,
      ]),
    ).not.toContain('"opencodeLineHeld":');
  });
});
