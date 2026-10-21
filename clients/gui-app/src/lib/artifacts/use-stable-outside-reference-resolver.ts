import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ArtifactsSlice } from "@/stores/epics/open-epic/types";
import type { ArtifactOutsideReferenceResolver } from "@/lib/sandbox/artifact-serving";
import { createArtifactOutsideReferenceResolver } from "./artifact-object-paths";

/** Projection updates must refresh cross-artifact lookups without reloading the page. */
export function useStableOutsideReferenceResolver(
  artifacts: ArtifactsSlice,
): ArtifactOutsideReferenceResolver {
  const resolver = useMemo(
    () => createArtifactOutsideReferenceResolver(artifacts),
    [artifacts],
  );
  const current = useRef(resolver);
  useLayoutEffect(() => {
    current.current = resolver;
  }, [resolver]);
  return useCallback((path: string) => current.current(path), []);
}
