import { describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { agentGetNativeSessionBindingV10 } from "@traycer/protocol/host/agent/contracts";
import {
  getAgentNativeSessionBindingRequestSchema,
  getAgentNativeSessionBindingResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

const METHOD = "agent.getNativeSessionBinding";

describe("agent.getNativeSessionBinding compatibility", () => {
  it("registers 1.0 as an optional method with per-call unsupported degradation", () => {
    expect(agentGetNativeSessionBindingV10.method).toBe(METHOD);
    expect(agentGetNativeSessionBindingV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(hostRpcRegistry[METHOD].degrade).toEqual({ kind: "unsupported" });
    expect(hostRpcRegistry[METHOD][1].latestMinor).toBe(0);
    expect(hostRpcRegistry[METHOD][1].versions[0]?.contract).toBe(
      agentGetNativeSessionBindingV10,
    );
  });

  it("advertises only on the optional manifest and leaves released fixtures frozen", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
    expect(releasedMethodNames).not.toContain(METHOD);

    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest[METHOD]).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1],
    });
    expect(split.manifest[METHOD]).toBeUndefined();
  });
});

describe("agent.getNativeSessionBinding schemas", () => {
  it("requires non-empty epic, sender, and exact target ids", () => {
    const request = {
      epicId: "epic-1",
      senderAgentId: "agent-caller",
      agentId: "agent-target",
    };
    expect(getAgentNativeSessionBindingRequestSchema.parse(request)).toEqual(
      request,
    );

    for (const field of ["epicId", "senderAgentId", "agentId"] as const) {
      expect(
        getAgentNativeSessionBindingRequestSchema.safeParse({
          ...request,
          [field]: "",
        }).success,
      ).toBe(false);
    }
    expect(
      getAgentNativeSessionBindingRequestSchema.safeParse({
        epicId: "epic-1",
        agentId: "agent-target",
      }).success,
    ).toBe(false);
  });

  it("accepts an ambient GUI binding whose native session is not observed yet", () => {
    const response = {
      agentId: "agent-gui",
      surface: "gui" as const,
      harnessId: "claude",
      profileSelection: { kind: "ambient" as const },
      harnessSessionId: null,
    };
    expect(getAgentNativeSessionBindingResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("accepts a managed TUI binding and keeps harness ids open for future providers", () => {
    const response = {
      agentId: "agent-tui",
      surface: "tui" as const,
      harnessId: "future-provider",
      profileSelection: {
        kind: "profile" as const,
        profileId: "profile-work",
      },
      harnessSessionId: "native-session-123",
    };
    expect(getAgentNativeSessionBindingResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("projects only allowlisted binding fields", () => {
    const parsed = getAgentNativeSessionBindingResponseSchema.parse({
      agentId: "agent-tui",
      surface: "tui",
      harnessId: "codex",
      profileSelection: {
        kind: "profile",
        profileId: "profile-work",
        label: "Work account",
      },
      harnessSessionId: "thread-123",
      email: "private@example.com",
      accountUuid: "account-secret",
      configPath: "/private/provider/config",
      authState: "authenticated",
      token: "secret",
      transcript: "private prompt",
      observedAt: "invented-timestamp",
    });

    expect(parsed).toEqual({
      agentId: "agent-tui",
      surface: "tui",
      harnessId: "codex",
      profileSelection: {
        kind: "profile",
        profileId: "profile-work",
      },
      harnessSessionId: "thread-123",
    });
  });

  it("rejects empty harness and native session ids", () => {
    const base = {
      agentId: "agent-tui",
      surface: "tui",
      harnessId: "codex",
      profileSelection: {
        kind: "profile",
        profileId: "profile-work",
      },
      harnessSessionId: "thread-123",
    };
    expect(
      getAgentNativeSessionBindingResponseSchema.safeParse({
        ...base,
        harnessId: "",
      }).success,
    ).toBe(false);
    expect(
      getAgentNativeSessionBindingResponseSchema.safeParse({
        ...base,
        harnessSessionId: "",
      }).success,
    ).toBe(false);
  });
});
