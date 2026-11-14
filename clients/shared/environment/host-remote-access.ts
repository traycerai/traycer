/**
 * Turning Remote access on for a computer, at authn on the person's own
 * sign-in: `PUT /api/v3/hosts/:hostId/remote-access`. The person's own
 * computer, or the owning team's Admin or Editor, may call it. The app sends
 * On only; Off stays the computer's own call (`host.remoteAccess.set@2.0`).
 *
 * The two shapes mirror authn's `hostRemoteAccessPutRequestSchema` and
 * `hostRemoteAccessPutResponseSchema`. What the computer does with the answer
 * is read from its own `environment.status`, not from this one.
 */
import { z } from "zod";
import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  isSuccess,
  sendSettings,
  settingsRefusal,
  type EnvironmentCloud,
} from "./environment-cloud";

const hostRemoteAccessPutRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

const hostRemoteAccessPutResponseSchema = z
  .object({
    remoteAccess: z
      .object({ enabled: z.boolean(), epoch: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

/**
 * Turns Remote access on for `hostId`. Throws {@link EnvironmentCloudError}
 * for every answer other than authn's 200: nothing answered, the sign-in or
 * the role refused, the computer is not found (404) or is a sandbox (409),
 * or the cloud failed.
 */
export async function turnOnHostRemoteAccess(
  cloud: EnvironmentCloud,
  hostId: string,
): Promise<void> {
  const answer = await sendSettings(
    cloud,
    "PUT",
    `api/v3/hosts/${encodeURIComponent(hostId)}/remote-access`,
    hostRemoteAccessPutRequestSchema.parse({ enabled: true }),
  );
  if (!isSuccess(answer)) throw settingsRefusal(answer);
  if (!hostRemoteAccessPutResponseSchema.safeParse(answer.body).success)
    throw new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
}
