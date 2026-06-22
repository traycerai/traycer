import { useEffect, useMemo, useRef } from "react";
import type { MentionCollaborator } from "@/hooks/comments/use-mention-collaborators";

export interface FilterCollaboratorsOptions {
  readonly maxResults: number;
}

/**
 * Pure filter so the suggestion plugin's `items` callback stays
 * synchronous. Match against display name + email; case-insensitive prefix
 * boost so a user typing `@an` sees their own name first if they share a
 * prefix with another collaborator.
 */
export function filterCollaborators(
  collaborators: ReadonlyArray<MentionCollaborator>,
  query: string,
  options: FilterCollaboratorsOptions,
): ReadonlyArray<MentionCollaborator> {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return collaborators.slice(0, options.maxResults);
  }
  const matches = collaborators.filter((c) => {
    const name = c.displayName.toLowerCase();
    const email = c.email.toLowerCase();
    return name.includes(trimmed) || email.includes(trimmed);
  });
  matches.sort((a, b) => {
    const aPrefix = a.displayName.toLowerCase().startsWith(trimmed) ? 0 : 1;
    const bPrefix = b.displayName.toLowerCase().startsWith(trimmed) ? 0 : 1;
    return aPrefix - bPrefix;
  });
  return matches.slice(0, options.maxResults);
}

/**
 * Identity-stable ref over the live collaborator list, so the suggestion
 * plugin closure always reads the freshest snapshot without forcing the
 * Tiptap editor to rebuild on every list refresh. The returned ref object
 * is the same instance across renders; only `.current` updates.
 */
export function useStableCollaboratorRef(
  collaborators: ReadonlyArray<MentionCollaborator>,
) {
  const ref = useRef(collaborators);
  useEffect(() => {
    ref.current = collaborators;
  }, [collaborators]);
  return useMemo(() => ref, []);
}

/**
 * Two-letter initials fallback for the avatar circle. We intentionally use
 * the display name (not email) as the source so renaming a user changes
 * the initials immediately, matching how Views renders collaborator chips.
 */
export function deriveInitials(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  const first = parts[0].charAt(0);
  const last = parts[parts.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
}
