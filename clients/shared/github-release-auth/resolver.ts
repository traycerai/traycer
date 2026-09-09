import { readGitHubCliToken } from "./github-cli";
import { AuthenticationRequiredError, trimSecret } from "./redact";
import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  STAGING_RELEASE_TOKEN_ENV,
  type CredentialLease,
} from "./types";

export class GitHubReleaseCredentialResolver {
  private lease: CredentialLease | null = null;
  private inFlight: Promise<CredentialLease> | null = null;
  // Bumped by every discard, so a resolution that started before one can tell
  // that its answer is already stale.
  private generation = 0;

  discardLease(): void {
    this.lease = null;
    // INVALIDATE WHATEVER IS ALREADY RUNNING, not just what is cached.
    // `checkForUpdatesNow()` calls `prepareStagingUpdateToken()` before it
    // consults `checkInFlight`, so concurrent IPC, startup and resume checks
    // can enter `resolveOrThrow()` together. Without this, a
    // `readGitHubCliToken()` that started before the 401 finishes after the
    // discard and caches the token the server just rejected - and because a
    // cached lease is returned unconditionally, every later request reuses it
    // and fails the same way for the process lifetime.
    this.generation += 1;
    this.inFlight = null;
  }

  async resolveOrThrow(): Promise<CredentialLease> {
    if (this.lease !== null) return this.lease;
    // One resolution at a time: concurrent callers join it rather than racing
    // to be the one that assigns.
    if (this.inFlight !== null) return this.inFlight;
    const pending = this.resolveFresh(this.generation);
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  private async resolveFresh(generation: number): Promise<CredentialLease> {
    const environmentToken = trimSecret(
      process.env[STAGING_RELEASE_TOKEN_ENV] ?? "",
    );
    if (environmentToken.length > 0) {
      return this.adopt(
        { source: "environment", token: environmentToken },
        generation,
      );
    }
    const cliToken = await readGitHubCliToken(process.env);
    if (cliToken !== null) {
      return this.adopt({ source: "github-cli", token: cliToken }, generation);
    }
    throw new AuthenticationRequiredError(AUTHENTICATION_REQUIRED_MESSAGE);
  }

  private adopt(lease: CredentialLease, generation: number): CredentialLease {
    // The caller still receives this lease - it may well be a freshly valid
    // token - but it only becomes the CACHED answer when no discard happened
    // while it was being read. That is the whole difference between one
    // failed request and a process that can never authenticate again.
    if (generation === this.generation) this.lease = lease;
    return lease;
  }
}
