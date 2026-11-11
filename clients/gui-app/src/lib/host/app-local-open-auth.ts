import { onAppLocalAdmissionInvalidated } from "./local-admission-invalidation";
export { invalidateLocalTeamAdmissionAfterClaim } from "./local-admission-invalidation";
import { createLocalOpenAuth } from "@traycer-clients/shared/host-transport/create-local-open-auth";
import type { LocalOpenAuth } from "@traycer-clients/shared/host-transport/local-open-auth";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import { appServerClock } from "@/lib/clock/app-server-clock";
import {
  mintAppMemberCredential,
  noteAppMemberCredentialAdopted,
} from "@/lib/auth/host-credential-provisioning";
import { getGuiClientIdentity } from "@/lib/host/client-identity";
import {
  noteLocalTeamAdmission,
  clearLocalTeamAdmission,
} from "@/stores/host/local-team-admission-store";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const authByBaseUrl = new Map<string, LocalOpenAuth>();

/** All local GUI transports share challenges, refusals, and in-flight intake. */
export function appLocalOpenAuthFor(authnBaseUrl: string): LocalOpenAuth {
  const existing = authByBaseUrl.get(authnBaseUrl);
  if (existing !== undefined) return existing;
  const auth = createLocalOpenAuth({
    authnBaseUrl,
    cloudAuthorized: () =>
      authorizesCloudCapability(useAuthStore.getState().status),
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    clientIdentity: getGuiClientIdentity(),
    clock: appServerClock,
    mintMemberCredential: (hostId) => mintAppMemberCredential(hostId),
    onMemberCredentialAdopted: noteAppMemberCredentialAdopted,
    onAdmissionState: noteLocalTeamAdmission,
    onAdmissionInvalidated: clearLocalTeamAdmission,
  });
  onAppLocalAdmissionInvalidated((hostId) => auth.invalidateHost(hostId, null));
  authByBaseUrl.set(authnBaseUrl, auth);
  return auth;
}
