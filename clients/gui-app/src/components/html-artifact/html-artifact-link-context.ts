import { createContext, use } from "react";
import { toast } from "sonner";
import type { SandboxArtifactLink } from "@/lib/sandbox/bridge-host";

/**
 * Opens what an html artifact page links to elsewhere in the artifacts tree.
 * `null` on a surface with no tree to resolve against or no tab to open a tile
 * in.
 *
 * Kept apart from `HtmlArtifactLinks` so that file exports only the component,
 * which Vite's react-refresh needs to hot-reload it.
 */
export const HtmlArtifactLinkContext = createContext<
  ((link: SandboxArtifactLink) => void) | null
>(null);

/** A surface that cannot open the link still answers the click. */
const linkUnopenable = (): void => {
  toast("Couldn't open link");
};

/** How a frame opens its page's link out of the artifact, on any surface. */
export function useHtmlArtifactLinkOpener(): (
  link: SandboxArtifactLink,
) => void {
  return use(HtmlArtifactLinkContext) ?? linkUnopenable;
}
