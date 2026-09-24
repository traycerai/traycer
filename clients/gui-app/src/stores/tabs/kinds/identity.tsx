import { lazy } from "react";
import { IdCard } from "lucide-react";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  useIdentityTabsStore,
  type IdentityTab,
} from "@/stores/identities/identity-tabs-store";
import { identityPathname, identityRoute } from "@/lib/routes";
import { identityTabIntent } from "@/lib/tab-navigation/intents";
import type { TabKindModule } from "@/stores/tabs/types";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

const identitySurface = lazy(() =>
  import("@/components/identities/identity-surface").then((module) => ({
    default: module.IdentitySurface,
  })),
);

/**
 * Module for `kind: "identity"` tabs: one per open identity, deep-linkable at
 * `/identities/{identityId}`, bound to the host its record names for life.
 *
 * `readinessScope: "tab-host"` because everything the surface does - the two
 * stream lanes and every unary - goes to `tab.hostId`, never to the app-wide
 * effective host. No duplication and no new window: the identity session is
 * keyed `(hostId, identityId)` and a second tab for it would share the same
 * session under a second tab id the route cannot name.
 */
export const identityTabModule: TabKindModule<"identity", IdentityTab> = {
  kind: "identity",
  build: (source) => ({
    kind: "identity",
    id: source.id,
    identityId: source.identityId,
    hostId: source.hostId,
    route: identityPathname(source.identityId),
    name: source.title.length > 0 ? source.title : "Identity",
    icon: IdCard,
    canDuplicate: false,
    canOpenInNewWindow: false,
    appearance: null,
  }),
  descriptor: {
    kind: "identity",
    surface: {
      render: (tab) => renderIdentitySurface(tab.identityId, tab.hostId),
      canonicalRoute: (tab) => tab.route,
      splitEligibility: "eligible",
      duplication: "forbidden",
      singleton: "per-instance",
      newWindow: "none",
      readinessScope: "tab-host",
      durableState: { owner: "identity-tabs", eviction: "reconstruct" },
    },
    duplicate: () => null,
    resolveIntent: (tab) => identityTabIntent(tab.identityId),
    routeOptions: (intent) => identityRoute(intent.identityId),
    activate: (intent) => {
      useLandingDraftStore.getState().clearActiveDraft();
      useIdentityTabsStore.getState().setActiveTab(intent.identityId);
    },
    requestClose: (tab) => {
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "identity",
        id: tab.id,
      });
    },
    requiresCloseConfirm: () => false,
    openInNewWindow: () => undefined,
    matchesPath: (tab, pathname) => pathname === tab.route,
  },
};

function renderIdentitySurface(identityId: string, hostId: string) {
  const IdentitySurface = identitySurface;
  return <IdentitySurface identityId={identityId} hostId={hostId} />;
}
