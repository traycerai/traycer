import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { FilePlus2 } from "lucide-react";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import * as Y from "yjs";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { artifactDocumentBundle } from "@/editor-core/artifact-document-bundle";
import { commitArtifactImageWithRetry } from "@/hooks/artifacts/commit-artifact-image-with-retry";
import {
  useArtifactImageOperations,
  type ArtifactImagePreparation,
} from "@/hooks/artifacts/use-artifact-image-operations";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import { useEpicArtifactRecords, useOpenEpicId } from "@/lib/epic-selectors";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { cn } from "@/lib/utils";
import { epicMutationKeys } from "@/lib/query-keys";

export type AddToArtifactImageSource =
  | { readonly kind: "client"; readonly url: string }
  | { readonly kind: "remote"; readonly url: string };

export function AddImageToArtifactButton(props: {
  readonly source: AddToArtifactImageSource;
  readonly alt: string;
  readonly className: string | undefined;
}): ReactNode {
  const epicId = useOpenEpicId();
  const handle = useOpenEpicHandle();
  const operations = useArtifactImageOperations(epicId);
  const records = useEpicArtifactRecords();
  const artifacts = useMemo(
    () => records.filter((record) => isEpicArtifactKind(record.type)),
    [records],
  );
  const [open, setOpen] = useState(false);

  const addMutation = useMutation<void, Error, string>({
    mutationKey: epicMutationKeys.addImageToArtifact(),
    mutationFn: async (artifactId) => {
      let operationId: string | null = null;
      let rollback: (() => void) | null = null;
      try {
        const prepared =
          props.source.kind === "remote"
            ? await operations.prepareRemote(props.source.url)
            : await prepareClientImage(
                props.source.url,
                operations.prepareBytes,
              );
        operationId = prepared.operationId;
        const releaseBody = handle.store
          .getState()
          .acquireArtifactBodyLease(artifactId);
        try {
          const fragment = handle.store
            .getState()
            .getArtifactFragment(artifactId);
          if (fragment === null) {
            throw new Error("This artifact is not available for editing.");
          }
          rollback = appendArtifactImage(fragment, {
            src: prepared.src,
            alt: props.alt,
            attachmentHash: prepared.attachmentHash,
            mediaType: prepared.mediaType,
          });
          await commitArtifactImageWithRetry(
            operations.commit,
            artifactId,
            prepared.operationId,
          );
          operationId = null;
        } finally {
          releaseBody();
        }
      } catch (reason) {
        rollback?.();
        if (operationId !== null) {
          await operations.abort(artifactId, operationId).catch(() => {});
        }
        throw reason instanceof Error ? reason : new Error("Please try again.");
      }
    },
    onSuccess: () => setOpen(false),
  });

  if (!operations.supported) return null;

  const stopImageClick = (event: MouseEvent): void => event.stopPropagation();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className={cn(
            "pointer-events-none opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
            props.className,
          )}
          aria-label="Add image to artifact"
          onClick={stopImageClick}
        >
          <FilePlus2 className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(85vw,20rem)] p-2"
        onClick={stopImageClick}
      >
        <p className="px-2 pb-2 text-ui-sm font-medium">Add to artifact</p>
        <div className="max-h-[min(50vh,20rem)] overflow-y-auto">
          {artifacts.length === 0 ? (
            <p className="px-2 py-3 text-ui-sm text-muted-foreground">
              No artifacts available.
            </p>
          ) : (
            artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-accent disabled:opacity-60"
                disabled={addMutation.isPending}
                onClick={() => addMutation.mutate(artifact.id)}
              >
                <span className="truncate">{artifact.name}</span>
                {addMutation.isPending &&
                addMutation.variables === artifact.id ? (
                  <AgentSpinningDots
                    className="ml-auto text-muted-foreground"
                    testId={undefined}
                    variant={undefined}
                  />
                ) : null}
              </button>
            ))
          )}
        </div>
        {addMutation.error === null ? null : (
          <p
            className="mt-2 border-t border-border px-2 pt-2 text-ui-xs text-destructive"
            role="alert"
          >
            {addMutation.error.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

async function prepareClientImage(
  url: string,
  prepareBytes: (bytes: Uint8Array) => Promise<ArtifactImagePreparation>,
): Promise<ArtifactImagePreparation> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("The image bytes are no longer available.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) {
    throw new Error("The image exceeds the 30 MB artifact image limit.");
  }
  return prepareBytes(bytes);
}

function appendArtifactImage(
  fragment: Y.XmlFragment,
  attrs: {
    readonly src: string;
    readonly alt: string;
    readonly attachmentHash: string;
    readonly mediaType: string;
  },
): () => void {
  const templateDoc = new Y.Doc();
  const template = templateDoc.getXmlFragment("artifact-image");
  prosemirrorJSONToYXmlFragment(
    artifactDocumentBundle.schema,
    { type: "doc", content: [{ type: "image", attrs }] },
    template,
  );
  const node = template.get(0);
  if (!(node instanceof Y.XmlElement)) {
    throw new Error("The artifact image node could not be created.");
  }
  const inserted = node.clone();
  fragment.push([inserted]);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = fragment.toArray().indexOf(inserted);
    if (index >= 0) fragment.delete(index, 1);
  };
}
