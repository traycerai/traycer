import { rm } from "node:fs/promises";
import {
  writeCredentialsFile,
  type StoredCredentials,
} from "@traycer/protocol/config/credentials";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";

/** The three ways the credentials file answers a rotation that no refresh can follow. */
export const SIGN_OUT_ARMS = ["deleted", "tombstoned", "user-mismatch"] as const;
export type SignOutArm = (typeof SIGN_OUT_ARMS)[number];

/**
 * Puts the file the lease's sign-in was read from into `arm`, as another
 * process would: removed (deleted); signed out and then recreated by a raw
 * writer, so the sign-out still stands (tombstoned); or switched to another
 * person's sign-in (user-mismatch).
 */
export async function standSignOutArm(
  arm: SignOutArm,
  args: {
    readonly credentialsPath: string;
    /** A handle on the file other than the command's own. */
    readonly otherProcess: CredentialsMutationStore;
    /** What the file held, to put back (tombstoned) or switch the person of (user-mismatch). */
    readonly credentials: StoredCredentials;
  },
): Promise<void> {
  switch (arm) {
    case "deleted":
      await rm(args.credentialsPath, { force: true });
      return;
    case "tombstoned":
      await args.otherProcess.signOut(null);
      await writeCredentialsFile(args.credentialsPath, args.credentials, 0);
      return;
    case "user-mismatch":
      await args.otherProcess.signIn(
        {
          ...args.credentials,
          user: { ...args.credentials.user, id: "another-user" },
        },
        false,
        null,
      );
      return;
  }
}
