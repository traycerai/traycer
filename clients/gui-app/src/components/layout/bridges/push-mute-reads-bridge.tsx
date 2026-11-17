import type { ReactNode } from "react";
import { usePushMutedSeveritiesQuery } from "@/hooks/runner/use-push-muted-severities-query";
import { usePushPermissionQuery } from "@/hooks/runner/use-push-permission-query";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * Keeps the phone's push permission and muted set read for the whole session,
 * not only while Settings → Alerts is open, because the toast gate reads them
 * at every arrival (`useNotificationNotifies`). Each read re-runs when the
 * phone says it may have changed. Draws nothing, and holds no reads on a
 * shell without push.
 */
export function PushMuteReadsBridge(): ReactNode {
  const { pushPermission } = useRunnerHost();
  return pushPermission === null ? null : <PushMuteReads />;
}

function PushMuteReads(): null {
  usePushPermissionQuery();
  usePushMutedSeveritiesQuery();
  return null;
}
