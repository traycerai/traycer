import { beforeEach, describe, expect, it } from "vitest";
import {
  mcpPendingAuthKeyString,
  useMcpPendingAuthStore,
  type McpPendingAuthKey,
} from "@/stores/settings/mcp-pending-auth-store";

function key(profileId: string | null): McpPendingAuthKey {
  return {
    providerId: "codex",
    profileId,
    scope: "global",
    workspaceRoot: null,
    serverName: "context7",
  };
}

describe("mcp-pending-auth-store profileId keying (D17, W2-T12b)", () => {
  beforeEach(() => {
    useMcpPendingAuthStore.setState({ entries: {} });
  });

  it("keys two profiles' same-named server separately", () => {
    expect(mcpPendingAuthKeyString(key("profile-a"))).not.toBe(
      mcpPendingAuthKeyString(key("profile-b")),
    );
    expect(mcpPendingAuthKeyString(key(null))).not.toBe(
      mcpPendingAuthKeyString(key("profile-a")),
    );
  });

  it("does not let one profile's pending auth clobber another's", () => {
    const store = useMcpPendingAuthStore.getState();
    store.upsert({
      key: key("profile-a"),
      hostId: "host-1",
      startedAt: 1,
      authorizationUrl: "https://auth.example.com/a",
      instruction: null,
    });
    store.upsert({
      key: key("profile-b"),
      hostId: "host-1",
      startedAt: 2,
      authorizationUrl: "https://auth.example.com/b",
      instruction: null,
    });

    expect(
      useMcpPendingAuthStore.getState().get(key("profile-a"))?.authorizationUrl,
    ).toBe("https://auth.example.com/a");
    expect(
      useMcpPendingAuthStore.getState().get(key("profile-b"))?.authorizationUrl,
    ).toBe("https://auth.example.com/b");

    useMcpPendingAuthStore.getState().remove(key("profile-a"));
    expect(useMcpPendingAuthStore.getState().get(key("profile-a"))).toBeNull();
    expect(
      useMcpPendingAuthStore.getState().get(key("profile-b"))?.authorizationUrl,
    ).toBe("https://auth.example.com/b");
  });
});
