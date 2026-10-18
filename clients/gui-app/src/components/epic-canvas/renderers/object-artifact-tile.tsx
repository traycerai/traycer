import { useMemo } from "react";
import { SandboxFrame, type SandboxSource } from "@/components/sandbox/sandbox-frame";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useArtifactById } from "@/lib/epic-selectors";
import { EPIC_NODE_LABELS } from "@/lib/artifacts/node-display";
import { artifactSourcePathsFor } from "@/lib/artifacts/artifact-object-paths";
import { useStableOutsideReferenceResolver } from "@/lib/artifacts/use-stable-outside-reference-resolver";
import { createHostObjectReader } from "@/lib/sandbox/artifact-serving/host-object-reader";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";

const noop = (): void => undefined;
const NO_PERMISSIONS = [] as const;

export function ObjectArtifactTile(props: { readonly node: EpicArtifactRef; readonly epicId: string }) {
  const artifact = useArtifactById(props.node.id);
  const artifacts = useEpicStore(state => state.artifacts);
  const client = useTabHostClient();
  const readSpan = useMemo(() => createHostObjectReader({
    epicId: props.epicId,
    request: (method, params, signal) => client === null
      ? Promise.resolve({ kind: "unavailable", reason: "missing" })
      : client.requestWithSignal(method, params, signal),
  }), [client, props.epicId]);
  const resolveOutsideReference = useStableOutsideReferenceResolver(artifacts);
  const source = useMemo<SandboxSource | null>(() => {
    if (artifact?.kind !== "html" || artifact.head === undefined) return null;
    const paths = artifactSourcePathsFor(artifact, artifacts);
    if (paths === null) return null;
    return { kind: "artifact", artifactId: artifact.id, manifest: artifact.head, readSpan, resolveOutsideReference, ...paths };
  }, [artifact, artifacts, readSpan, resolveOutsideReference]);
  if (artifact === null) return <div className="p-4 text-muted-foreground">Artifact unavailable.</div>;
  if (source !== null) {
    return <SandboxFrame source={source} kind="page" title={artifact.title}
      appName={null} networkPolicy="https-only" appCsp={null} permissions={NO_PERMISSIONS}
      appRequests={null} className="h-full w-full" height={null} onSize={noop} onStatus={noop}
      onRequestTeardown={noop} displayMode="inline" onBridge={null} ref={null} />;
  }
  const byteLength = artifact.object?.byteLength ?? (artifact.head === undefined ? null : Object.values(artifact.head.files).reduce((total, file) => total + file.byteLength, 0));
  return <div className="flex min-w-0 flex-col gap-2 p-4">
    <div className="truncate">{artifact.title || EPIC_NODE_LABELS[artifact.kind]}</div>
    <div className="text-sm text-muted-foreground">{EPIC_NODE_LABELS[artifact.kind]}{byteLength === null ? "" : ` · ${byteLength.toLocaleString()} bytes`}</div>
  </div>;
}
