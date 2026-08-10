import { useActiveLandingDraftShell } from "@/stores/home/landing-draft-store";
import { LandingDraftSurface } from "@/components/home/landing-draft-surface";
import { DraftSurfaceProvider } from "@/providers/draft-surface-provider";

export function HomePage() {
  const { draftId } = useActiveLandingDraftShell();

  return (
    <DraftSurfaceProvider draftId={draftId}>
      <LandingDraftSurface />
    </DraftSurfaceProvider>
  );
}
