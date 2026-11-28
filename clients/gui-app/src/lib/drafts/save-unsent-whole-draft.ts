import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { ContextType } from "@traycer/protocol/common/json-content-serializer";
import {
  mentionPlainTextFromAttrs,
  slashCommandLabelFromAttrs,
} from "@traycer/protocol/common/composer-plain-text";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  draftComposerHeadSchemaV11,
  isHostPathMention,
  projectDraftRunSettingsV11,
  type DraftComposerHeadV11,
} from "@traycer/protocol/persistence/draft/schemas";
import {
  DRAFT_HEAD_DIALECT,
  DRAFT_HEAD_SCHEMA_VERSION_V11,
} from "@traycer/protocol/persistence/draft/version";
import { collectAnnotationImageHashes } from "@/lib/browser-view/annotation/browser-annotation-record";
import { putImageBytesAtHash } from "@/lib/composer/landing-image-store";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import { putDraftBlobs } from "@/lib/drafts/draft-blob-transport";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import {
  resolveDraftImageBytes,
  type DraftImageByteTarget,
} from "@/lib/drafts/resolve-draft-image-bytes";
import { materializeInlineImages } from "@/lib/drafts/unrecorded-prompt-handoff";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { getAppHostClientSnapshot } from "@/lib/host/runtime";
import { queryClient } from "@/lib/query-client";
import type { PendingSandboxSend } from "@/stores/sandboxes/pending-sandbox-send-store";

export function wholeDraftSaveClient() {
  if (readProcessHostRpcTierPlan().pool === null) return null;
  const client = getAppHostClientSnapshot();
  if (
    client === null ||
    !readNegotiatedMethodVersion(POOL_HOST_ID, "drafts.mutateWhole")
  )
    return null;
  return resolvePoolTierHostClient(client);
}

/** Keep the words a dead machine reference displayed, in the same position. */
function portableContent(node: JsonContent): JsonContent {
  const attrs = node.attrs;
  if (node.type === "fileAttachment") {
    return { type: "text", text: stringValue(attrs?.fileName) ?? "File" };
  }
  if (
    node.type === "mention" &&
    (isHostPathMention(node) || attrs?.contextType === ContextType.Attachment)
  ) {
    return {
      type: "text",
      text:
        stringValue(attrs?.label) ??
        (mentionPlainTextFromAttrs(attrs) || "File"),
    };
  }
  if (node.type === "slashCommand" && attrs?.path) {
    return {
      type: "text",
      text: slashCommandLabelFromAttrs(attrs) || "/command",
    };
  }
  return node.content === undefined
    ? node
    : { ...node, content: node.content.map(portableContent) };
}

function wholeHeadForSend(
  send: PendingSandboxSend,
  content: JsonContent,
): DraftComposerHeadV11 | null {
  const { request } = send;
  if (request.kind !== "chat" && request.kind !== "message") return null;
  const annotations = [...(request.browserAnnotations ?? [])];
  const blobHashes = [
    ...new Set([
      ...blobHashesFromContent(content),
      ...collectAnnotationImageHashes(annotations),
    ]),
  ];
  const { profileBinding: _, ...settings } = send.settings;
  const runSettings = projectDraftRunSettingsV11(
    { ...settings, profileId: null },
    null,
    null,
  );
  if (runSettings.status !== "ready") return null;
  const head = draftComposerHeadSchemaV11.safeParse({
    dialect: DRAFT_HEAD_DIALECT,
    schemaVersion: DRAFT_HEAD_SCHEMA_VERSION_V11,
    kind: "draft",
    surfaceKind: "landing",
    lastTouchedAt: Date.now(),
    target: { epicId: null, chatId: null, blockId: null },
    hostLocal: { hostId: POOL_HOST_ID, workspace: null },
    portable: {
      content,
      selection: null,
      runSettings: runSettings.settings,
      composerMode: "chat",
      blobHashes,
      closed: true,
      annotations,
    },
  });
  return head.success ? head.data : null;
}

export async function saveUnsentWholeDraft(input: {
  readonly send: PendingSandboxSend;
  readonly draftId: string;
  readonly source: DraftImageByteTarget;
  readonly stillCurrent: () => boolean;
}): Promise<DraftComposerHeadV11 | null> {
  const { send, draftId, source, stillCurrent } = input;
  const client = wholeDraftSaveClient();
  if (client === null || send.userId === null || !stillCurrent()) return null;
  return queryClient
    .getMutationCache()
    .build(queryClient, {
      mutationFn: async () => {
        const images = await materializeInlineImages(
          portableContent(send.content),
        );
        if (!stillCurrent() || images.dropped > 0) return null;
        const head = wholeHeadForSend(send, images.content);
        if (head === null) return null;
        const { blobHashes } = head.portable;
        for (const hash of blobHashes) {
          const bytes =
            images.bytesByHash.get(hash)?.bytes ??
            (await resolveDraftImageBytes(hash, source));
          if (bytes === null || !stillCurrent()) return null;
          if (!(await putImageBytesAtHash(hash, bytes))) return null;
        }
        if (!stillCurrent()) return null;
        const stored = await putDraftBlobs(
          POOL_HOST_ID,
          client,
          blobHashes,
          send.userId,
        );
        if (
          !stillCurrent() ||
          blobHashes.some((hash) => !stored.includes(hash))
        )
          return null;
        const receipt = await client.request("drafts.mutateWhole", {
          kind: "save",
          draftId,
          head,
        });
        return stillCurrent() &&
          receipt.kind === "saved" &&
          receipt.draftId === draftId
          ? head
          : null;
      },
    })
    .execute(undefined);
}
