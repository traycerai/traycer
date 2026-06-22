import { LayersPlus } from "lucide-react";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type { LandingDraftTab } from "@/stores/home/landing-draft-store";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { draftRoute, draftPathname } from "@/lib/routes";
import { draftTabIntent } from "@/lib/tab-navigation/intents";
import type { TabKindModule } from "@/stores/tabs/types";

const DRAFT_LABEL_FALLBACK = "Start Page";

/**
 * Module for `kind: "draft"` tabs. Each draft has its own
 * deep-linkable URL (`/draft/{draftId}`), so active highlighting
 * comes from URL matching - no `activeDraftId` cross-store read
 * needed at the strip level. The display `name` is derived at build
 * time from the draft content's first line (cheap - content is
 * hash-only, no base64); empty derived text (e.g. image-only draft)
 * → fallback label "Start Page".
 */
export const draftTabModule: TabKindModule<"draft", LandingDraftTab> = {
  kind: "draft",
  build: (source) => ({
    kind: "draft",
    id: source.id,
    route: draftPathname(source.id),
    name: draftTabName(source.content),
    icon: LayersPlus,
    canDuplicate: false,
    canOpenInNewWindow: false,
  }),
  descriptor: {
    kind: "draft",
    duplicate: () => null,
    resolveIntent: (tab) => draftTabIntent(tab.id),
    routeOptions: (intent) => draftRoute(intent.draftId),
    activate: (intent) => {
      useLandingDraftStore.getState().setActiveDraft(intent.draftId);
    },
    requestClose: (tab) => {
      useLandingDraftStore.getState().closeDraft(tab.id);
    },
    requiresCloseConfirm: () => false,
    openInNewWindow: () => undefined,
    matchesPath: (tab, pathname) => pathname === tab.route,
  },
};

function draftTabName(content: LandingDraftTab["content"]): string {
  const text = extractPlainTextFromComposerJSONContent(content).trim();
  if (text.length === 0) return DRAFT_LABEL_FALLBACK;
  return text.split("\n")[0].trim() || DRAFT_LABEL_FALLBACK;
}
