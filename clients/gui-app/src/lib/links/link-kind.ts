import type { LinkKindSetting } from "@/stores/settings/settings-store";

/**
 * Where a clicked URL came from (A1, A2). The four `LinkKindSetting` kinds
 * answer to the user's in-app/external setting; the rest are always external -
 * auth flows, provider docs, billing/account pages, and app pages (release
 * notes, report issue, OS deep links) have no in-app meaning.
 */
export type LinkKind = LinkKindSetting | "auth" | "docs" | "account" | "app";

// A total record rather than a set literal: adding a kind fails the build here
// instead of silently defaulting to "hard external".
const CONFIGURABLE_BY_KIND: Record<LinkKind, boolean> = {
  markdown: true,
  terminal: true,
  github: true,
  image: true,
  auth: false,
  docs: false,
  account: false,
  app: false,
};

export function isConfigurableLinkKind(
  kind: LinkKind,
): kind is LinkKindSetting {
  return CONFIGURABLE_BY_KIND[kind];
}
