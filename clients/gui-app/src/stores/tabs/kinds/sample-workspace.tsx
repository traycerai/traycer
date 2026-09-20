import { createElement, lazy } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { HeaderTab, TabKindModule } from "@/stores/tabs/types";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

const sampleWorkspaceSurface = lazy(() =>
  import("@/components/sample-workspace/sample-workspace-surface").then(
    (module) => ({ default: module.SampleWorkspaceSurface }),
  ),
);
const tab: Extract<HeaderTab, { kind: "sample-workspace" }> = {
  kind: "sample-workspace",
  id: "sample-workspace",
  route: "/sample-workspace",
  name: "Sample workspace",
  icon: PanelsTopLeft,
  canDuplicate: false,
  canOpenInNewWindow: false,
};
export const sampleWorkspaceTabModule: TabKindModule<"sample-workspace", null> =
  {
    kind: "sample-workspace",
    build: () => tab,
    descriptor: {
      kind: "sample-workspace",
      surface: {
        render: (tab) =>
          createElement(sampleWorkspaceSurface, { tabId: tab.id }),
        canonicalRoute: (tab) => tab.route,
        splitEligibility: "ineligible",
        duplication: "forbidden",
        singleton: "per-window",
        newWindow: "none",
        readinessScope: "none",
        durableState: { owner: "none", eviction: "reconstruct" },
      },
      duplicate: () => null,
      resolveIntent: () => ({ kind: "sample-workspace" }),
      routeOptions: () => ({ to: "/sample-workspace" }),
      activate: () => undefined,
      requestClose: (tab) => {
        tabCommandCoordinator.closeRefAfterConfirmed({
          kind: tab.kind,
          id: tab.id,
        });
      },
      requiresCloseConfirm: () => false,
      openInNewWindow: () => undefined,
      matchesPath: (tab, pathname) => pathname === tab.route,
    },
  };
