import { useEffect } from "react";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useHostClient } from "@/lib/host";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * Opens this build's server pool session once a cloud-authorized user is
 * signed in, mounted once per app. Nothing if the build has no pool.
 *
 * The pool's families gate on the pool's manifest (`useHostSupportsMethod`
 * reads the serving tier), and a manifest is recorded only by a session that
 * has handshaken. The pool's stream clients start lazily, on their first
 * subscribe, and their subscribers wait on that gate - so without this the
 * gate and the session each wait for the other. One `host.status`, a floor
 * method every peer serves, starts the shared session; the runtime
 * messenger's pool binding then holds it and keeps it reconnecting.
 */
export function PoolSessionMount(): null {
  const hostClient = useHostClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  useEffect(() => {
    if (
      readProcessHostRpcTierPlan().pool === null ||
      !authorized ||
      userId === null
    ) {
      return;
    }
    // The outcome is the session's, reported through its own availability
    // and manifest; a failed first call leaves the binding redialing.
    resolvePoolTierHostClient(hostClient)
      .request("host.status", {})
      .catch(() => undefined);
  }, [hostClient, authorized, userId]);
  return null;
}
