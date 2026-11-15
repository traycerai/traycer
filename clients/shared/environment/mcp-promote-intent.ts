/**
 * The `mcp_promote` intent, the app's own call to authn on the person's
 * sign-in (`environment-cloud.ts`): a person's "Add to <environment>" on an
 * MCP server only one computer holds. The server's definition can hold
 * values that computer never shows the app, so the computer uploads it on its
 * own token, and authn accepts that upload once against this intent.
 *
 * - `POST …/mcp-servers/promote-intents`: records the intent for the source
 *   computer at its sharing generation and the server's name. The target is
 *   the path's environment. A repeat with the same operation id and body
 *   answers the same intent.
 * - `GET …/mcp-servers/promote-intents/:operationId`: the intent's state, to
 *   the person who recorded it only.
 *
 * One click binds the computer, its generation and the name, not the content
 * of what is uploaded: the app is never shown a server's arguments or its
 * secret values.
 */
import { z } from "zod";
import {
  environmentPath,
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

/** What the click records: the computer the server is on, at its generation, and the server's name. */
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

/**
 * The intent's state. `consumed` names the server row the computer's upload
 * created or reused, and wins over the end.
 */
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

/**
 * Records the intent in `environmentId`. Resolves when authn holds it; any
 * other answer is an `EnvironmentCloudError`.
 */
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

/** Reads the state of the intent recorded as `operationId` in `environmentId`. */
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
