import type { ReactNode } from "react";
import {
  useTeamComputerInstallTokenLatest,
  useTeamComputerInstallTokenMutation,
} from "@/hooks/host/use-team-computer-install-token-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { TeamComputerUnattended } from "./team-computer-unattended";

/** A new observer on account change prevents even a render of the old token. */
export function TeamComputerUnattendedSetup(props: {
  readonly environmentId: string;
}): ReactNode {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  if (!signedIn || userId === null) return null;
  return (
    <AccountInstallToken
      key={`${userId}:${props.environmentId}`}
      environmentId={props.environmentId}
    />
  );
}

function AccountInstallToken(props: {
  readonly environmentId: string;
}): ReactNode {
  const mutation = useTeamComputerInstallTokenMutation(props.environmentId);
  const latest = useTeamComputerInstallTokenLatest(props.environmentId);
  return (
    <TeamComputerUnattended
      teamSelector={props.environmentId}
      pending={latest.pending}
      token={latest.token}
      failure={latest.failure}
      onMint={() => {
        if (!latest.pending) mutation.mutate();
      }}
    />
  );
}
