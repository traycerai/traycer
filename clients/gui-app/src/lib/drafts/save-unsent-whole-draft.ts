import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { ContextType } from "@traycer/protocol/common/json-content-serializer";
import { decodeDraftHeadDocumentV11 } from "@traycer/protocol/persistence/draft/document";
import {
  mentionPlainTextFromAttrs,
  slashCommandLabelFromAttrs,
} from "@traycer/protocol/common/composer-plain-text";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { spendScopeKeysEqual } from "@traycer/protocol/host/provider-profile-inheritance";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { validate as isUuid } from "uuid";
import {
  draftComposerHeadSchemaV11,
  isHostPathMention,
  projectDraftRunSettingsV11,
  type DraftComposerHeadV11,
  type DraftEnvironmentProfileBinding,
  type DraftRunSettingsV11,
} from "@traycer/protocol/persistence/draft/schemas";
import {
  DRAFT_HEAD_DIALECT,
  DRAFT_HEAD_SCHEMA_VERSION_V11,
} from "@traycer/protocol/persistence/draft/version";
import {
  collectAnnotationImageHashes,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import { putImageBytesAtHash } from "@/lib/composer/landing-image-store";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import {
  currentDraftBlobOwnerId,
  invalidateDraftBlobConfirmations,
  putDraftBlobs,
} from "@/lib/drafts/draft-blob-transport";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import {
  resolveDraftImageBytes,
  type DraftImageByteTarget,
} from "@/lib/drafts/resolve-draft-image-bytes";
import { materializeInlineImages } from "@/lib/drafts/unrecorded-prompt-handoff";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { getAppHostClientSnapshot } from "@/lib/host/runtime";
import { hashCloudDraftHead } from "@/lib/drafts/cloud-draft-reader";
import { readProviderProfiles } from "@/lib/commands/actions/resolve-cloned-chat-settings";
import { sameJsonContent } from "@/stores/home/landing-draft-content";
import { queryClient } from "@/lib/query-client";
import { recordCloudDraftImageSources } from "@/lib/drafts/cloud-draft-image-recovery";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { providersListQueryKey } from "@/lib/query-keys/providers-query-keys";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  sameNullableChatRunSettings,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import type { PendingSandboxSend } from "@/stores/sandboxes/pending-sandbox-send-store";

const freshRead = {
  retry: false,
  gcTime: 0,
  staleTime: 0,
  networkMode: "always",
} as const;

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

/** Undefined is an inconclusive read. Only an exact absence permits a re-save. */
export async function readSavedWholeDraft(
  draftId: string,
  userId: string | null,
  stillCurrent: () => boolean,
): Promise<DraftComposerHeadV11 | null | undefined> {
  if (userId === null || !stillCurrent()) return undefined;
  const result = await queryClient
    .fetchQuery({
      queryKey: [
        ...hostQueryKeys.methodScope(POOL_HOST_ID, "epic.resolveCloudChatHead"),
        "whole-draft-return",
        userId,
        draftId,
      ],
      ...freshRead,
      queryFn: async () => {
        const client = wholeDraftSaveClient();
        if (client === null) return {};
        const { scopeId } = await client.request("drafts.list", {});
        if (!scopeId || !stillCurrent()) return {};
        const identity = {
          taskId: scopeId,
          chatId: draftId,
          ownerUserId: userId,
        };
        const { outcome } = await client.request(
          "epic.resolveCloudChatHead",
          identity,
        );
        if (outcome.status === "missing") return { head: null };
        if (
          outcome.status !== "ok" ||
          outcome.headSha256 !==
            (await hashCloudDraftHead(outcome.head, webCryptoSha256Hex))
        )
          return {};
        const decoded = decodeDraftHeadDocumentV11(outcome.head);
        if (
          decoded.status !== "ok" ||
          decoded.record.hostLocal.hostId !== POOL_HOST_ID
        )
          return {};
        if (stillCurrent() && currentDraftBlobOwnerId() === userId)
          recordCloudDraftImageSources({
            identity,
            hostId: POOL_HOST_ID,
            client,
            hashes: decoded.record.portable.blobHashes,
          });
        return { head: decoded.record };
      },
    })
    .catch(() => ({}));
  return stillCurrent() && "head" in result ? result.head : undefined;
}

export function wholeLandingDraft(draftId: string | null | undefined) {
  if (draftId === null || draftId === undefined) return undefined;
  draftRuntimeRegistry.flush(draftId);
  const row = useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId);
  return row?.wholeDraftAnnotations === undefined ? undefined : row;
}

export async function retireSentWholeDraft(
  draftId: string | undefined,
  submission: Pick<PendingSandboxSend, "content" | "settings" | "userId"> & {
    readonly browserAnnotations?: ReadonlyArray<BrowserAnnotationRecord>;
  },
): Promise<void> {
  const row = wholeLandingDraft(draftId);
  if (
    row === undefined ||
    draftId === undefined ||
    !wholeDraftMatches(row, submission)
  )
    return;
  const client = wholeDraftSaveClient();
  if (client === null || submission.userId === null) return;
  const current = () =>
    authorizesCloudCapability(useAuthStore.getState().status) &&
    currentDraftBlobOwnerId() === submission.userId &&
    wholeLandingDraft(draftId)?.generation === row.generation;
  const deleted = await queryClient
    .getMutationCache()
    .build(queryClient, {
      mutationFn: async () => {
        if (!current()) return false;
        const receipt = await client.request("drafts.mutateWhole", {
          kind: "delete",
          draftId,
        });
        return receipt.kind === "deleted" && receipt.draftId === draftId;
      },
    })
    .execute(undefined)
    .catch(() => false);
  if (deleted && current())
    useLandingDraftStore.getState().applyHostDelete(draftId);
}

export function wholeDraftMatches(
  row: LandingDraftTab,
  submission: Pick<PendingSandboxSend, "content" | "settings"> & {
    readonly browserAnnotations?: ReadonlyArray<BrowserAnnotationRecord>;
  },
): boolean {
  return (
    row.composerMode === "chat" &&
    sameJsonContent(row.content, submission.content) &&
    JSON.stringify(row.wholeDraftAnnotations ?? []) ===
      JSON.stringify(submission.browserAnnotations ?? []) &&
    (row.settings === null ||
      sameNullableChatRunSettings(row.settings, submission.settings))
  );
}

/** Keep the words a dead machine reference displayed, in the same position. */
function portableContent(node: JsonContent): JsonContent {
  const label = localReferenceLabel(node);
  if (label !== null) return { type: "text", text: label };
  return node.content === undefined
    ? node
    : { ...node, content: node.content.map(portableContent) };
}

export function contentHasLocalDraftReference(node: JsonContent): boolean {
  return (
    localReferenceLabel(node) !== null ||
    (node.content ?? []).some(contentHasLocalDraftReference)
  );
}

function localReferenceLabel(node: JsonContent): string | null {
  const attrs = node.attrs;
  if (node.type === "fileAttachment")
    return stringValue(attrs?.fileName) ?? "File";
  if (
    node.type === "mention" &&
    (isHostPathMention(node) || attrs?.contextType === ContextType.Attachment)
  )
    return (
      stringValue(attrs?.label) ?? (mentionPlainTextFromAttrs(attrs) || "File")
    );
  return node.type === "slashCommand" && attrs?.path
    ? slashCommandLabelFromAttrs(attrs) || "/command"
    : null;
}

function wholeHeadForSend(
  send: PendingSandboxSend,
  content: JsonContent,
  binding: DraftEnvironmentProfileBinding | null,
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
  const projected = projectDraftRunSettingsV11(send.settings, null, binding);
  const runSettings =
    projected.status === "ready"
      ? projected
      : projectDraftRunSettingsV11(
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

async function readShareableProfiles(
  hostId: string | null,
  harnessId: ChatRunSettings["harnessId"],
  ownerUserId: string,
): Promise<ReadonlyArray<ProviderProfile>> {
  const providerId = guiHarnessIdToProviderId(harnessId);
  const app = getAppHostClientSnapshot();
  const current = () =>
    currentDraftBlobOwnerId() === ownerUserId &&
    authorizesCloudCapability(useAuthStore.getState().status);
  if (app === null || hostId === null || providerId === null || !current())
    return [];
  const profiles = await queryClient.fetchQuery({
    queryKey: [...providersListQueryKey(hostId), ownerUserId, providerId],
    queryFn: () =>
      readProviderProfiles(app.createRequesterForHostId(hostId), providerId),
    ...freshRead,
  });
  return current() ? (profiles ?? []) : [];
}

async function confirmedProfileBinding(
  send: PendingSandboxSend,
  hostId: string | null,
): Promise<DraftEnvironmentProfileBinding | null> {
  const { profileId, profileBinding, harnessId } = send.settings;
  if (send.userId === null || profileId === null) return null;
  const profiles = await readShareableProfiles(hostId, harnessId, send.userId);
  const profile = profiles.find(
    (candidate) =>
      candidate.profileId === profileId &&
      candidate.kind === "managed" &&
      candidate.presence?.kind === "admitted" &&
      (profileBinding === undefined ||
        (profileBinding.kind === "key" &&
          candidate.credentialIdentity?.kind === "spend-scoped" &&
          spendScopeKeysEqual(
            profileBinding.key,
            candidate.credentialIdentity.spendScopeKey,
          ))),
  );
  const id = profile?.environmentProfileId;
  return id && isUuid(id)
    ? { kind: "environment-profile", environmentProfileId: id }
    : null;
}

/** A portable binding is applied only through a profile admitted on this host. */
export async function restoreWholeDraftRunSettings(
  portable: DraftRunSettingsV11 | null,
  userId: string | null,
): Promise<ChatRunSettings | null> {
  if (portable === null) return null;
  const { profileBinding, ...settings } = portable;
  if (profileBinding === undefined || userId === null) return settings;
  const hostId = getAppHostClientSnapshot()?.getActiveHostId() ?? null;
  const profiles = await readShareableProfiles(
    hostId,
    settings.harnessId,
    userId,
  );
  const profile = profiles.find(
    (candidate) =>
      candidate.environmentProfileId === profileBinding.environmentProfileId &&
      candidate.kind === "managed" &&
      candidate.presence?.kind === "admitted",
  );
  if (profile?.credentialIdentity?.kind !== "spend-scoped") return settings;
  return {
    ...settings,
    profileId: profile.profileId,
    profileBinding: {
      kind: "key",
      key: profile.credentialIdentity.spendScopeKey,
    },
  };
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
        const binding = await confirmedProfileBinding(send, source.hostId);
        const head = wholeHeadForSend(send, images.content, binding);
        if (head === null || !stillCurrent()) return null;
        const { blobHashes } = head.portable;
        for (const hash of blobHashes) {
          const bytes =
            images.bytesByHash.get(hash)?.bytes ??
            (await resolveDraftImageBytes(hash, source));
          if (bytes === null || !stillCurrent()) return null;
          if (!(await putImageBytesAtHash(hash, bytes))) return null;
        }
        if (!stillCurrent()) return null;
        const stored = new Set(
          await putDraftBlobs(POOL_HOST_ID, client, blobHashes, send.userId),
        );
        if (!stillCurrent() || blobHashes.some((hash) => !stored.has(hash)))
          return null;
        return client
          .request("drafts.mutateWhole", { kind: "save", draftId, head })
          .then(
            (receipt) =>
              receipt.kind === "saved" && receipt.draftId === draftId
                ? head
                : null,
            (error: unknown) => {
              if (
                !(error instanceof HostRpcError) ||
                error.code !== "CHAT_PUBLICATION_STALE_AUTHORITY"
              )
                throw error;
              invalidateDraftBlobConfirmations(POOL_HOST_ID, blobHashes);
              return null;
            },
          );
      },
    })
    .execute(undefined);
}
