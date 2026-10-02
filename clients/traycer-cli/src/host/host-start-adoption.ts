import {
  publishHostStartAdoption as publishAtHome,
  consumeHostStartAdoption as consumeAtHome,
  readHostStartAdoptionNonce as readNonceAtHome,
  type HostStartAdoptionLease,
  type HostStartAdoptionConsumeResult,
} from "@traycer-clients/shared/host-start-adoption";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import type { Environment } from "../runner/environment";
import { hostHomeDir } from "../store/paths";
import type { HostStartOrigin } from "./lifecycle-origin";
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
  return publishAtHome(
    capability,
    options.hostHomeDir ?? hostHomeDir(options.environment),
    serviceLabel,
    origin,
  );
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
