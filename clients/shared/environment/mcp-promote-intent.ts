// The computer uploads the server's definition on its own token, since it can hold
// values never shown to the app; authn accepts that upload once against this
// intent. A repeat with the same operation id and body answers the same intent.
import { z } from "zod";
import {
  environmentPath,
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

export interface McpPromoteIntent {
  readonly operationId: string;
  readonly sourceHostId: string;
  readonly sourceSharingGeneration: number;
  readonly serverName: string;
}

const recordAnswerSchema = z.object({
  operationId: z.uuid(),
  endsAt: z.number().int().positive(),
});

/** `consumed` names the row the upload created or reused, and wins over the end. */
const mcpPromoteIntentStateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pending"),
    endsAt: z.number().int().positive(),
  }),
  z.object({ state: z.literal("consumed"), mcpServerId: z.uuid() }),
  z.object({ state: z.literal("ended") }),
]);
export type McpPromoteIntentState = z.infer<typeof mcpPromoteIntentStateSchema>;

function promoteIntentsPath(environmentId: string): string {
  return `${environmentPath(environmentId)}/mcp-servers/promote-intents`;
}

export async function recordMcpPromoteIntent(
  cloud: EnvironmentCloud,
  environmentId: string,
  intent: McpPromoteIntent,
): Promise<void> {
  const answer = await sendSettings(
    cloud,
    "POST",
    promoteIntentsPath(environmentId),
    {
      operationId: intent.operationId,
      kind: "mcp_promote",
      sourceHostId: intent.sourceHostId,
      sourceSharingGeneration: intent.sourceSharingGeneration,
      serverName: intent.serverName,
    },
  );
  parseSettings(answer, recordAnswerSchema);
}

export async function readMcpPromoteIntent(
  cloud: EnvironmentCloud,
  environmentId: string,
  operationId: string,
): Promise<McpPromoteIntentState> {
  const answer = await sendSettings(
    cloud,
    "GET",
    `${promoteIntentsPath(environmentId)}/${encodeURIComponent(operationId)}`,
    null,
  );
  return parseSettings(answer, mcpPromoteIntentStateSchema);
}
