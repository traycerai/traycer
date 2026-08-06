/**
 * Both-direction bridge coverage for the lines `host-v1.1.10` froze without
 * the fields that had been riding them (`epic.createTuiAgent@1.0` without
 * `forkSourceHarnessSessionId`, `providers.list@4.0/5.0/6.0` requests without
 * `native` - the release cherry-pick dropped the commits that added them).
 *
 * Drives the real registries through the same traversal helpers the host
 * handler (`upgradeRequestToVersion` / `downgradeResponseAcrossMajors`) and
 * the client transport (zod-strip on the older minor's request schema,
 * `downgradeRequestAcrossMajors`) execute at runtime, so a transform that
 * drops or leaks one of these fields fails here, not against a released peer.
 */
import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  createTuiAgentRequestSchemaV10,
  createTuiAgentRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  providersListRequestSchema,
  providersListRequestSchemaBeforeV70,
  providersListResponseSchema,
  providersListResponseSchemaV60,
} from "@traycer/protocol/host/provider-schemas";

const createTuiRegistry = hostRpcRegistry["epic.createTuiAgent"];
const providersListRegistry = hostRpcRegistry["providers.list"];

const canonicalCreateRequest = createTuiAgentRequestSchema.parse({
  epicId: "e1",
  parentId: null,
  title: "t",
  harnessId: "claude",
  harnessSessionId: "sess-1",
  terminalShellCommand: null,
  terminalShellArgs: null,
  hostId: "h1",
  workspaceFolders: ["/w"],
  model: null,
  agentMode: "regular",
  forkSourceHarnessSessionId: "fork-src-1",
});

describe("epic.createTuiAgent 1.0 <-> 1.1", () => {
  it("released 1.0 client -> new host: V10 parse accepts the released shape, chain fills null", () => {
    // Exactly what a released v1.1.10 client sends (no fork field).
    const released = {
      epicId: "e1",
      parentId: null,
      title: "t",
      harnessId: "claude",
      harnessSessionId: null,
      terminalShellCommand: null,
      terminalShellArgs: null,
      hostId: "h1",
      workspaceFolders: ["/w"],
      model: null,
      agentMode: "regular",
    };
    const parsed = createTuiAgentRequestSchemaV10.parse(released);
    const canonical = upgradeRequestToVersion(
      createTuiRegistry,
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      parsed,
    );
    expect(canonical.forkSourceHarnessSessionId).toBeNull();
    expect(() => createTuiAgentRequestSchema.parse(canonical)).not.toThrow();
    // Host response leg back to the 1.0 caller: same-major identity + strip.
    const response = { tuiAgentId: "a1" };
    const up = upgradeResponseToVersion(
      createTuiRegistry,
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      response,
    );
    expect(up).toEqual(response);
  });

  it("new 1.1 client -> released 1.0 host: transport zod-strip projects the fork field away", () => {
    // Mirrors prepareRequestPayload's same-major newer-client branch.
    const stripped = createTuiAgentRequestSchemaV10.safeParse(
      canonicalCreateRequest,
    );
    expect(stripped.success).toBe(true);
    if (!stripped.success) return;
    expect(stripped.data).not.toHaveProperty("forkSourceHarnessSessionId");
    // Everything the released host's schema models survives projection.
    expect(stripped.data.harnessSessionId).toBe("sess-1");
    expect(stripped.data.profileId).toBeNull();
  });
});

const releasedProvidersRequest = { forceAuthRefresh: true };

describe("providers.list request lines 1.0..6.0 <-> 7.0", () => {
  it("released callers at every major upgrade to canonical with native:null", () => {
    for (const major of [1, 2, 3, 4, 5, 6] as const) {
      const parsed =
        providersListRequestSchemaBeforeV70.parse(releasedProvidersRequest);
      const canonical = upgradeRequestToVersion(
        providersListRegistry,
        { major, minor: 0 },
        { major: 7, minor: 0 },
        parsed,
      );
      expect(canonical, `major ${major}`).toEqual({
        forceAuthRefresh: true,
        native: null,
      });
      expect(() => providersListRequestSchema.parse(canonical)).not.toThrow();
    }
  });

  it("a new 7.0 client downgrades its request to every released major without leaking native", () => {
    const canonical = providersListRequestSchema.parse({
      forceAuthRefresh: true,
      native: {
        kind: "mcp",
        providerId: "claude-code",
        scope: "global",
        workspaceRoot: null,
      },
    });
    for (const major of [1, 2, 3, 4, 5, 6] as const) {
      const down = downgradeRequestAcrossMajors(
        providersListRegistry,
        7,
        major,
        canonical,
      );
      expect(down.ok, `major ${major}`).toBe(true);
      if (!down.ok) continue;
      expect(down.value, `major ${major}`).not.toHaveProperty("native");
      expect(
        providersListRequestSchemaBeforeV70.safeParse(down.value).success,
        `major ${major} reparse`,
      ).toBe(true);
    }
  });

  it("response round-trip 7.0 -> 6.0 -> 7.0 still parses at both ends", () => {
    const canonicalResponse = providersListResponseSchema.parse({
      providers: [],
      native: null,
    });
    const down = downgradeResponseAcrossMajors(
      providersListRegistry,
      7,
      6,
      canonicalResponse,
    );
    expect(down.ok).toBe(true);
    if (!down.ok) return;
    expect(down.value).not.toHaveProperty("native");
    expect(providersListResponseSchemaV60.safeParse(down.value).success).toBe(
      true,
    );
    const back = upgradeResponseToVersion(
      providersListRegistry,
      { major: 6, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV60.parse(down.value),
    );
    expect(back.native).toBeNull();
    expect(providersListResponseSchema.safeParse(back).success).toBe(true);
  });
});
