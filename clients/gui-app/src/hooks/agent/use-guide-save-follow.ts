import { settingsSaveRequestId } from "@traycer/protocol/framework/settings-save-request-id";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import type { SettingsSaveFollow } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

type GuideSaveMethod =
  | "agent.selectionGuide.setGlobal"
  | "agent.selectionGuide.resetGlobalToDefault";

/** Tags Personal presses for the host's room path, with no item proposal to follow. */
export function useGuideSaveFollow<Method extends GuideSaveMethod>(
  method: Method,
): SettingsSaveFollow<HostRpcRegistry, Method> | undefined {
  const scope = useEnvironmentPick();
  const source = useEnvironmentCloud();
  if (scope.kind !== "personal" || source === null) return undefined;
  return {
    source,
    follow: (_request, _client, origin) => {
      if (
        origin.kind === "sign_in_at_press" &&
        !origin.operation.onOriginSignIn()
      )
        return Promise.resolve({ kind: "abandoned", method });
      return Promise.resolve({
        kind: "send",
        requestId:
          origin.kind === "sign_in_at_press"
            ? settingsSaveRequestId(crypto.randomUUID())
            : undefined,
        answered: () => undefined,
        failed: () => undefined,
      });
    },
    proposes: () => false,
  };
}
