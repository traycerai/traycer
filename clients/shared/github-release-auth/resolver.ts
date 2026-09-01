import { readGitHubCliToken } from "./github-cli";
import { AuthenticationRequiredError, trimSecret } from "./redact";
import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  STAGING_RELEASE_TOKEN_ENV,
  type CredentialLease,
} from "./types";

export class GitHubReleaseCredentialResolver {
  private lease: CredentialLease | null = null;

  discardLease(): void {
    this.lease = null;
  }

  async resolveOrThrow(): Promise<CredentialLease> {
    if (this.lease !== null) return this.lease;
    const environmentToken = trimSecret(
      process.env[STAGING_RELEASE_TOKEN_ENV] ?? "",
    );
    if (environmentToken.length > 0) {
      this.lease = { source: "environment", token: environmentToken };
      return this.lease;
    }
    const cliToken = await readGitHubCliToken(process.env);
    if (cliToken !== null) {
      this.lease = { source: "github-cli", token: cliToken };
      return this.lease;
    }
    throw new AuthenticationRequiredError(AUTHENTICATION_REQUIRED_MESSAGE);
  }
}
