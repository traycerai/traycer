import { useState, type ReactNode } from "react";
import {
  createFrameCommentSurfaceStore,
  FrameCommentSurfaceContext,
} from "./frame-comment-surface-context";

/** Pin ownership belongs to this tile, including its toolbar portal. */
export function FrameCommentSurfaceProvider(props: {
  readonly children: ReactNode;
}) {
  const [store] = useState(createFrameCommentSurfaceStore);
  return (
    <FrameCommentSurfaceContext value={store}>
      {props.children}
    </FrameCommentSurfaceContext>
  );
}
