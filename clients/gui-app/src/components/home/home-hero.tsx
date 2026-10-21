import { useState } from "react";
import { landingPrompt } from "@/components/home/landing-prompt";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { basenameOfPath } from "@/lib/path";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";

function timeGreeting(hour: number): string {
  if (hour < 5) return "Burning the midnight oil";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Burning the midnight oil";
}

function readFirstName(userName: string): string | null {
  if (userName.includes("@")) return null;

  const firstName = userName
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)[0];

  if (firstName.length === 0) return null;
  return `${firstName[0].toUpperCase()}${firstName.slice(1)}`;
}

interface HomeHeroProps {
  readonly workspaceFolders: ReadonlyArray<string> | null;
}

export function HomeHero({ workspaceFolders }: HomeHeroProps) {
  // The hero is a landing surface: its folder fallback follows the landing
  // composer's own placement (pin ?? effective) - the bucket must describe
  // the machine the composer beside it will actually create on.
  const activeHostId = useComposerSurfaceHostPin().resolvedHostId;
  const globalFolders = useWorkspaceFoldersStore(
    (state) => selectWorkspaceFoldersBucket(state, activeHostId).folders,
  );
  const folders = workspaceFolders === null ? globalFolders : workspaceFolders;
  const profile = useAuthStore((state) => state.profile);
  const [greeting] = useState(() => timeGreeting(new Date().getHours()));
  const [prompt] = useState(() => landingPrompt());

  const projectName = folders.length > 0 ? basenameOfPath(folders[0]) : null;
  const firstName = profile === null ? null : readFirstName(profile.userName);

  return (
    <div
      data-landing-hero
      className="relative isolate flex flex-col items-center gap-3 text-center"
    >
      <h1 className="text-display font-medium text-foreground sm:text-display">
        {greeting}
        {firstName === null ? null : `, ${firstName}`}
      </h1>
      <p className="text-ui text-muted-foreground sm:text-title-sm">
        {prompt}
        {projectName !== null ? (
          <span className="text-muted-foreground/70">
            {" "}
            in <span className="text-foreground">{projectName}</span>
          </span>
        ) : null}
      </p>
    </div>
  );
}
