// The app sends On only; Off stays the computer's own call (`host.remoteAccess.set@2.0`).
// The computer's state is read from its `environment.status`, not this answer.
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
