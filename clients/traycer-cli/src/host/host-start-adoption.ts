import {
  publishHostStartAdoption as publishAtHome,
  consumeHostStartAdoption as consumeAtHome,
  readHostStartAdoptionNonce as readNonceAtHome,
  type HostStartAdoptionLease,
  type HostStartAdoptionConsumeResult,
} from "@traycer-clients/shared/host-start-adoption";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import { SpawnAcknowledgementTimeoutError } from "@traycer-clients/shared/host-start-adoption/spawn-acknowledgement-error";
import type { Environment } from "../runner/environment";
import { hostHomeDir } from "../store/paths";
import type { HostStartOrigin } from "./lifecycle-origin";
import { attachCliSpawnAckEvidence } from "./spawn-ack-evidence";
import type { WithCliUpdateContenderOptions } from "./update-contender";

export {
  __setBeforeHostStartAdoptionClaimHookForTest,
  __setBeforeHostStartAdoptionReadHookForTest,
  type HostStartAdoptionLease,
  type HostStartAdoptionGrant,
  type HostStartAdoptionConsumeResult,
  type HostStartAdoptionPublisher,
} from "@traycer-clients/shared/host-start-adoption";

export async function publishHostStartAdoption(
  capability: UpdateMutationCapability,
  options: WithCliUpdateContenderOptions,
  serviceLabel: string,
  origin: HostStartOrigin,
): Promise<HostStartAdoptionLease> {
  const publishedAtMs = Date.now();
  const lease = await publishAtHome(
    capability,
    options.hostHomeDir ?? hostHomeDir(options.environment),
    serviceLabel,
    origin,
  );
  return {
    // A timeout leaves this lease exactly as it was; the service's own records
    // are read into the same error for the tags its capture carries.
    waitForSpawn: async (): Promise<void> => {
      try {
        await lease.waitForSpawn();
      } catch (error) {
        if (error instanceof SpawnAcknowledgementTimeoutError) {
          await attachCliSpawnAckEvidence(
            error,
            options.environment,
            publishedAtMs,
          );
        }
        throw error;
      }
    },
    cancel: () => lease.cancel(),
  };
}

export async function consumeHostStartAdoption(
  environment: Environment,
  serviceLabel: string | null,
  expectedNonce: string | null,
): Promise<HostStartAdoptionConsumeResult> {
  return consumeAtHome(hostHomeDir(environment), serviceLabel, expectedNonce);
}

export async function readHostStartAdoptionNonce(
  environment: Environment,
  serviceLabel: string,
): Promise<string | null> {
  return readNonceAtHome(hostHomeDir(environment), serviceLabel);
}
