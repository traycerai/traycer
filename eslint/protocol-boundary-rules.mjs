/**
 * Hard-bans direct imports of `@traycer/protocol/<domain>/_internal/...` from any workspace except `protocol/` itself.
 * `_internal/` modules host the raw Zod record schemas (e.g. `epicSchema`, `permissionRoleSchema`, `userSchema`, `roomMetadataSchema`).
 */
export const protocolBoundaryRestrictions = {
  patterns: [
    {
      group: ["@traycer/protocol/**/_internal/**"],
      // No leak crosses the boundary, including type-only imports.
      // Recursive types that need a `z.ZodType<...>` annotation are co-located with the registry instead of `_internal/` for exactly this reason.
      message:
        "Do not import from `@traycer/protocol/.../_internal/...`. " +
        'Use `getRecordSchema(<registry>, "<record-name>", "latest")` ' +
        "to obtain a versioned record schema, or use " +
        '`RecordValue<typeof <registry>, "<record-name>">` for the type.',
    },
  ],
};
