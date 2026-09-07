/** Cross-host browser-tab picks (spec decision #10). */
import { v4 as uuidv4 } from "uuid";
import { captureBrowserTabPreview } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { BrowserTabMentionEntry } from "@/lib/composer/types";

/** The one line the agent reads; it names the host so "localhost" is not ambiguous. */
export function browserTabPreviewText(entry: BrowserTabMentionEntry): string {
  const hostName = entry.hostLabel ?? entry.hostId;
  return `browser tab on ${hostName}: ${entry.label} - ${entry.url}`;
}

/**
 * Asks the owning host for the still.
 * Resolves to `null` whenever no image is coming (a dormant tab, a stream that went away, a host that refused): the text line is already in the composer and stands on its own.
 */
export async function fetchBrowserTabPreviewImage(
  entry: BrowserTabMentionEntry,
): Promise<ImageAttachmentAttrs | null> {
  const preview = await captureBrowserTabPreview(
    entry.coordinatorKey,
    entry.tabId,
  ).catch(() => null);
  if (preview === null || !preview.ok || preview.screenshotBase64 === null) {
    return null;
  }
  return {
    id: uuidv4(),
    fileName: `${entry.hostLabel ?? entry.hostId}-tab.jpg`,
    mimeType: "image/jpeg",
    size: null,
    b64content: preview.screenshotBase64,
  };
}
