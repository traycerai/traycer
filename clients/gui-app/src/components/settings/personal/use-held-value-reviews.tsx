import type { ReactNode } from "react";
import { HeldValueReview } from "@/components/settings/personal/held-value-review";
import { usePersonalHeldValues } from "@/components/settings/personal/personal-page-context";

/**
 * The `Review` control of each held value of `kind` whose item key starts
 * with `prefix`, by the rest of that key: a variable's name (prefix `""`), or
 * a provider override's name (prefix `<harness>:`).
 */
export function useHeldValueReviews(
  kind: "variable" | "env_override",
  prefix: string,
): ReadonlyMap<string, ReactNode> {
  const held = usePersonalHeldValues(kind);
  const reviews = new Map<string, ReactNode>();
  for (const [key, entry] of held) {
    if (!key.startsWith(prefix)) continue;
    reviews.set(
      key.slice(prefix.length),
      <HeldValueReview key={entry.entryId} entry={entry} />,
    );
  }
  return reviews;
}
