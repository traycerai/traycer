/**
 * How a surface names the host its draft image bytes may be on.
 *
 * A plain function rather than a hook, and read at CALL time rather than in
 * render, for two reasons:
 *
 *  - **It must not make a surface unmountable.** The host-runtime hooks throw
 *    with no `<HostRuntimeProvider>` above them, and a byte source is a
 *    convenience, not a reason for the message-copy affordance to fail to
 *    render. "No host to ask" is an answer this resolver already has.
 *  - **The live client is the right client.** A mirror session is acquired and
 *    released as tiles mount; a target memoized at render time can name a
 *    session that has since been released, or miss one acquired a moment ago.
 *
 * Kept out of `resolve-draft-image-bytes.ts` so that module stays a leaf: the
 * resolver takes the target as a value and is testable without the mirror
 * coordinator - and every consumer of the resolver would otherwise drag the
 * coordinator into its import graph.
 */
import { draftMirrorClientForHost } from "./draft-mirror-coordinator";
import type { DraftImageByteTarget } from "./resolve-draft-image-bytes";

export function draftImageByteTargetForHost(
  hostId: string | null,
): DraftImageByteTarget {
  return { hostId, client: draftMirrorClientForHost(hostId) };
}
