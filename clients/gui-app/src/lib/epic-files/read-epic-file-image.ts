import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";

import { MAX_IMAGE_BYTES } from "@/hooks/composer/use-composer-paste";

/**
 * One epic-file image, fetched as inline base64 for the composer.
 *
 * The imperative twin of `useFileBytes`'s `epic-file` leg (`lib/files/byte-source.ts`),
 * and it exists because the caller is a TOAST ACTION rather than a render: the
 * "Attach to chat" button has to have the bytes in hand BEFORE it seeds the
 * new-conversation draft, and a hook cannot answer inside a click handler.
 *
 * Both address arms end in a plain `fetch`: `loopback` is the D32 static server
 * on `127.0.0.1` when the client shares the host's machine, `url` a short-lived
 * signed cloud GET. `unavailable` is a real answer (the entry is tombstoned, or
 * the bytes have not finished uploading), not an error - the caller degrades to
 * the path-only draft rather than showing a failure.
 */
export interface EpicFileImageBytes {
  readonly b64content: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

export async function readEpicFileImage(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly coLocatedHostId: string | null;
}): Promise<EpicFileImageBytes | null> {
  const { client } = args;
  if (client === null) return null;
  const response = await client.request("epic.readFile", {
    epicId: args.epicId,
    path: args.path,
    sha256: args.sha256,
    coLocatedHostId: args.coLocatedHostId,
  });
  if (response.kind === "unavailable") return null;
  const httpResponse = await globalThis.fetch(response.url);
  if (!httpResponse.ok) return null;
  const blob = await httpResponse.blob();
  // The composer's own paste cap, applied to the same payload it would build:
  // an image the user could not have pasted must not arrive by another door.
  if (blob.size > MAX_IMAGE_BYTES) return null;
  const b64content = await blobToBase64(blob);
  if (b64content === null) return null;
  return {
    b64content,
    // The SNIFFED type when the host sent one - a file extension is not
    // evidence of what the bytes are.
    mediaType:
      response.kind === "url"
        ? response.mediaType
        : blob.type || args.mediaType,
    byteLength: blob.size,
  };
}

/**
 * `FileReader` rather than `btoa` over the bytes: the same conversion the paste
 * path uses, so a multi-megabyte capture cannot blow the argument limit that a
 * `String.fromCharCode(...bytes)` spread would.
 */
function blobToBase64(blob: Blob): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => {
      resolve(null);
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        resolve(null);
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? null : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}
