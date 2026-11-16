/**
 * The person's acceptance of a move or a give, recorded at authn on their own
 * sign-in (`environment-cloud.ts`): `POST /api/v3/hosts/:hostId/move-acceptances`.
 *
 * The body is the computer's stage answer laid flat,
 * `{ ...evidence, ...authorization }` (`environment.move.stage@1.0`), which is
 * authn's request for that arm as it stands: a move into Personal carries the
 * manifest hash, a give to a team the disclosure version and its hash. authn
 * answers the acceptance's id, which the app then hands the computer
 * (`environment.move.start@1.0`); the computer, not the app, moves itself.
 *
 * authn's two 409s (`operation_acceptance_invalid`, whatever its reason, and
 * `move_acceptance_conflict`) are one outcome here, `refused`: the screen has
 * one state for both.
 */
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

/**
 * Records the acceptance of what `hostId` staged. Throws
 * {@link EnvironmentCloudError} when nothing answered, the sign-in was
 * refused, the role does not allow it, or the cloud failed.
 */
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
