// The body is the computer's stage answer laid flat (`{ ...evidence, ...authorization }`).
// authn's two 409s are one outcome, `refused`: the screen has one state for both.
import { z } from "zod";
import type { EnvironmentMoveStageResponse } from "@traycer/protocol/host/environment/move-contracts";
import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  errorBodyCode,
  isSuccess,
  sendSettings,
  settingsRefusal,
  type EnvironmentCloud,
} from "./environment-cloud";

const moveAcceptanceResponseSchema = z.object({
  acceptanceId: z.uuid(),
});

const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "operation_acceptance_invalid",
  "move_acceptance_conflict",
]);

export type MoveAcceptanceOutcome =
  | { readonly kind: "accepted"; readonly acceptanceId: string }
  | { readonly kind: "refused" };

export async function recordMoveAcceptance(
  cloud: EnvironmentCloud,
  hostId: string,
  staged: EnvironmentMoveStageResponse,
): Promise<MoveAcceptanceOutcome> {
  const answer = await sendSettings(
    cloud,
    "POST",
    `api/v3/hosts/${encodeURIComponent(hostId)}/move-acceptances`,
    { ...staged.evidence, ...staged.authorization },
  );
  if (isSuccess(answer)) {
    const parsed = moveAcceptanceResponseSchema.safeParse(answer.body);
    if (!parsed.success)
      throw new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
    return { kind: "accepted", acceptanceId: parsed.data.acceptanceId };
  }
  const code = errorBodyCode(answer.body);
  if (answer.status === 409 && code !== null && REFUSAL_CODES.has(code))
    return { kind: "refused" };
  throw settingsRefusal(answer);
}
