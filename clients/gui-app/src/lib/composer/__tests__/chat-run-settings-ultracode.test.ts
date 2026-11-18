import { describe, expect, it } from "vitest";

import {
  buildChatRunSettings,
  importedChatSettingsSeed,
} from "@/lib/composer/chat-run-settings";

/**
 * The request rides the built tuple only for Claude: it is saved intent, so a
 * Claude selection keeps whatever the caller states, and any other harness
 * states false even when the caller passes true. An imported chat starts false.
 */

function build(harnessId: "claude" | "codex", ultracode: boolean) {
  return buildChatRunSettings({
    selection: { harnessId, modelSlug: "model-1", profileId: null },
    permission: "supervised",
    reasoning: "high",
    serviceTier: "",
    ultracode,
  });
}

describe("buildChatRunSettings ultracode", () => {
  it.each([true, false])("keeps a stated %s on Claude", (stated) => {
    expect(build("claude", stated).ultracode).toBe(stated);
  });

  it("states false on another harness even when true is passed", () => {
    expect(build("codex", true).ultracode).toBe(false);
  });
});

describe("importedChatSettingsSeed", () => {
  it("starts an imported chat with the request off even when the remembered settings had it on", () => {
    const remembered = build("claude", true);

    const seed = importedChatSettingsSeed(
      remembered,
      build("claude", false),
      "claude",
    );

    expect(seed.ultracode).toBe(false);
    expect(seed.model).toBe("");
  });
});
