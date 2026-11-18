import { isDevBuild } from "../config";
import { installDevRelayDropSwitch } from "./dev-relay-drop-switch";

// Vite removes this branch from every renderer release bundle. The baked
// desktop gate also keeps the hook out of staging/production source runs.
if (import.meta.env.DEV && isDevBuild) {
  const cleanup = installDevRelayDropSwitch(
    window,
    window.runnerHost.relayBaseUrl,
  );
  import.meta.hot?.dispose(cleanup);
}
