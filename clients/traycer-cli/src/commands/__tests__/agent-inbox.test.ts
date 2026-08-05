import { describe, expect, it } from "vitest";
import { buildAgentInboxCommand } from "../agent-inbox";
import { CLI_ERROR_CODES } from "../../runner/errors";

describe("agent inbox", () => {
  it("rejects malformed pagination cursors as invalid user input", async () => {
    const command = buildAgentInboxCommand({
      epicId: "epic-1",
      agentId: "agent-1",
      after: "not-a-cursor",
    });

    await expect(Reflect.apply(command, null, [])).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      details: null,
      exitCode: 1,
    });
  });
});
