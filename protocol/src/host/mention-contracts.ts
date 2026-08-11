/** Versioned unary RPC contracts for GitHub composer mentions. */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  mentionGithubCatalogRequestSchema,
  mentionGithubCatalogResponseSchema,
  mentionGithubSearchRequestSchema,
  mentionGithubSearchResponseSchema,
} from "./mention-schemas";

/**
 * `mention.githubCatalog@1.0` - stale-first catalog read plus an explicitly
 * requested cache refresh. `hostId` is deliberately absent: the active host
 * connection is the only host this request can target.
 */
export const mentionGithubCatalogV10 = defineRpcContract({
  method: "mention.githubCatalog",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: mentionGithubCatalogRequestSchema,
  responseSchema: mentionGithubCatalogResponseSchema,
});

/**
 * `mention.githubSearch@1.0` - scoped GitHub search, also used for a
 * non-default filter with an empty query. `hostId` is derived from the
 * connection, as it is for every `pr.*` method.
 */
export const mentionGithubSearchV10 = defineRpcContract({
  method: "mention.githubSearch",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: mentionGithubSearchRequestSchema,
  responseSchema: mentionGithubSearchResponseSchema,
});
