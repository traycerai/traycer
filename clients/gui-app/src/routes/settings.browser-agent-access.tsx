import { createFileRoute, redirect } from "@tanstack/react-router";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * Legacy redirect: Browser agent access is the Browser tab of Permissions. A
 * remembered path or a deep link lands on that page. A build without
 * environments (`unreleased-features.ts`) keeps the switch on the Browser
 * page, so the path lands there.
 */
export const Route = createFileRoute("/settings/browser-agent-access")({
  beforeLoad: () => {
    redirect({
      throw: true,
      to: UNRELEASED_FEATURES_ENABLED
        ? "/settings/permissions"
        : "/settings/browser",
      replace: true,
    });
  },
});
