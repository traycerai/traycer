import { describe, expect, it } from "vitest";
import { chatTileActivationQueryPolicy } from "@/components/epic-canvas/renderers/chat-tile-activation-query-policy";

describe("chatTileActivationQueryPolicy", () => {
  it("disables action-only activation queries for a locked published-chat copy", () => {
    expect(
      chatTileActivationQueryPolicy({
        readOnlyNotice: "This is a read-only synced copy.",
        surfaceVisible: true,
        surfaceFocused: true,
        tileActive: true,
        hasWorktreeBinding: true,
      }),
    ).toEqual({
      refreshMissingWorktreePaths: false,
      discoverActionSlashCommands: false,
      discoverCompactSlashCommands: false,
    });
  });

  it("preserves all activation queries for an active live chat", () => {
    expect(
      chatTileActivationQueryPolicy({
        readOnlyNotice: null,
        surfaceVisible: true,
        surfaceFocused: true,
        tileActive: true,
        hasWorktreeBinding: true,
      }),
    ).toEqual({
      refreshMissingWorktreePaths: true,
      discoverActionSlashCommands: true,
      discoverCompactSlashCommands: true,
    });
  });

  it("keeps ordinary activity gates for an inactive live chat", () => {
    expect(
      chatTileActivationQueryPolicy({
        readOnlyNotice: null,
        surfaceVisible: false,
        surfaceFocused: false,
        tileActive: false,
        hasWorktreeBinding: true,
      }),
    ).toEqual({
      refreshMissingWorktreePaths: false,
      discoverActionSlashCommands: false,
      discoverCompactSlashCommands: false,
    });
  });
});
