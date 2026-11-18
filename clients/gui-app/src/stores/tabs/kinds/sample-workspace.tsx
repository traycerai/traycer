import { createElement, lazy } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { HeaderTab, TabKindModule } from "@/stores/tabs/types";
import { TAB_KIND_SPLIT_ELIGIBILITY } from "@/stores/tabs/tab-kind-policy";

const sampleWorkspaceSurface = lazy(() =>
  import("@/components/sample-workspace/sample-workspace-surface").then(
    (module) => ({ default: module.SampleWorkspaceSurface }),
  ),
);
const tab: Extract<HeaderTab, { kind: "sample-workspace" }> = {
  kind: "sample-workspace",
  id: "sample-workspace",
  route: "/sample-workspace",
  // The tab says the MODE, because that is what this tab is: it is not a place
  // the user navigated to, it is the state the window is in (L-87). "Sample
  // workspace" described the CONTENT under it - which the canvas already says
  // twice, in its own banner and in its footer - and at sixteen characters it
  // was also the longest label in the strip, so it was the first thing the
  // strip's overflow cut in half (the owner's third live pass showed it
  // rendered as "Sample"). One word, always whole, and it answers the question
  // the amber is there to answer.
  name: "Customizing",
  // The same sliders the "Customize layout..." menu item wears.
  icon: SlidersHorizontal,
  canDuplicate: false,
  canOpenInNewWindow: false,
  // The one tab that is a MODE rather than a place, and the colour that says
  // so in the app's own status vocabulary (L-87). The `warning` role, because
  // nothing is broken and nothing is being destroyed - something is merely not
  // ordinary. It pairs with the dotted frame `layout-editor.css` draws around
  // the app column, which is the other half of "you are editing this screen"
  // and uses this same token.
  //
  // ONE treatment across both halves (L-138, L-163): the frame is the hollow
  // amber outline around the screen, and while this tab is ACTIVE it is the
  // one solid amber object inside it - `header-tab-visual.tsx` fills the tab's
  // real silhouette with this colour and leaves its edge to the ordinary
  // border. At rest the tab wears it as a cap along its bottom edge instead,
  // outside the passive dim that calms every other tab (L-132).
  //
  // The pair's FOREGROUND rather than its tint: `--warning` measures 2.56:1 to
  // 2.95:1 against the surfaces this lands on in every light palette, under
  // the 3:1 a non-text indicator owes, exactly as `--ring` did for the
  // selection ring (L-78). Both halves are measured in
  // `layout-editor/__tests__/layout-editor-contrast.test.ts`.
  appearance: { color: "var(--warning-foreground)", icon: null },
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
        splitEligibility: TAB_KIND_SPLIT_ELIGIBILITY["sample-workspace"],
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
      requestClose: (tab, close) => {
        close({ kind: tab.kind, id: tab.id });
      },
      requiresCloseConfirm: () => false,
      openInNewWindow: () => undefined,
      matchesPath: (tab, pathname) => pathname === tab.route,
    },
  };
