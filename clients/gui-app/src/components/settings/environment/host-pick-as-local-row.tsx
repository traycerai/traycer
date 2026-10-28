import { useEffect } from "react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * A build without environments (`unreleased-features.ts`) has no Environment
 * dropdown: the pages it would govern sit under the Host picker and read the
 * host it names, as that host's Local row, which is how they read before
 * environments. Written as the window's default pick, the way the dropdown
 * writes it, so every page reads one host and none reads the cloud. Mounted
 * by the sidebar, which is on screen for as long as any settings panel is.
 */
export function HostPickAsLocalRow(props: { readonly scope: HostScope }): null {
  const { hostId, hostLabel } = props.scope;
  const setDefaultPick = useSettingsEnvironmentPickStore(
    (state) => state.setDefaultPick,
  );
  useEffect(() => {
    setDefaultPick(
      hostId === null
        ? PERSONAL_PICK
        : { kind: "local", hostId, hostName: hostLabel },
    );
  }, [hostId, hostLabel, setDefaultPick]);
  return null;
}
