/**
 * Cross-host browser-tab picks (spec decision #10).
 *
 * A tab living on another host can never be driven from this chat - browser
 * sessions are host-local for life - so picking one attaches CONTEXT instead
 * of a reference: a text line naming the host, title and url, plus the
 * screenshot the owning host captured, carried as an ordinary
 * `imageAttachment` node. That is the same carrier a pasted image uses, so it
 * reaches the model as an image with no new persistence field, no
 * `browserAnnotations` entry (which is `chat.subscribe@1.7`-gated and
 * persisted) and no new chat client-frame field.
 */
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
 * Asks the owning host for the still. Resolves to `null` whenever no image is
 * coming (a dormant tab, a stream that went away, a host that refused): the
 * text line is already in the composer and stands on its own.
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
