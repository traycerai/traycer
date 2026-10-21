import { createContext } from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { CollabUser } from "@/editor-core/awareness/derive-collab-user";
import type {
  ArtifactOutsideReferenceResolver,
  ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import type { CanvasFrameEvents } from "./canvas-frame";
export interface CanvasArtifactFixture {
  readonly doc: Y.Doc;
  readonly awareness: Awareness | null;
  readonly user: CollabUser;
  readonly treePath: string;
  readonly readSpan: ArtifactReadSpan;
  readonly resolveOutsideReference: ArtifactOutsideReferenceResolver;
}
export const FixtureContext = createContext<CanvasArtifactFixture | null>(null);
/** Dev proof and tests bind the same editor without acquiring a live task lease. */
export const CanvasArtifactFixtureProvider = FixtureContext.Provider;
/** The frame-message track can install board link, error and hit-test handlers. */
export const CanvasFrameEventsContext = createContext<CanvasFrameEvents | null>(
  null,
);
