/**
 * D12 / F12 host-selection write+read layer (selection model §5).
 *
 * Seeded in Phase 0 so no new violations accrue while the migration runs.
 * The allowlist shrinks as later phases land; do not widen it without a
 * ticket. Plan:
 *   epics/c6042be5-cbd3-4923-8cbe-d2bc00ae7ade/artifacts/host-lifecycle-redesign
 *
 * Wire from gui-app `eslint.config.mjs`:
 *   - spread `selectByIdRestrictions` into `generalCustomSyntaxRestrictions`
 *     (write path); per-file overrides for the two legitimate writers filter
 *     this array out, same recomposition style as nested-focus / tab-nav
 *   - apply `hostSelectionReadImportRestrictions` via a
 *     `@typescript-eslint/no-restricted-imports` block whose `ignores` are
 *     `hostSelectionReadAllowlist` (read path)
 */

export const HOST_SELECTION_REDESIGN_PLAN =
  "epics/c6042be5-cbd3-4923-8cbe-d2bc00ae7ade/artifacts/host-lifecycle-redesign";

const SELECT_BY_ID_MESSAGE =
  "`selectById` is the selection authority bridge's alone (P1.2): it is a pure setter for the derived effective host, not a picker. A UI gesture that should move the app-wide selection calls `SelectionAuthorityClient.activate(...)` from the Settings activate module. See " +
  HOST_SELECTION_REDESIGN_PLAN +
  " (selection model §5).";

const ACTIVE_HOST_READ_MESSAGE =
  "Do not import `useAddressableHostId` or default-client hooks (`useHostClient`, `useDefaultHostClient`) outside the allowlisted layer (feeds, landing, epic-session registry, app chrome). Tab content must use `useTabHostId` / `useTabHostClient` / `useSurfaceHostPin`. See " +
  HOST_SELECTION_REDESIGN_PLAN +
  " (selection model §5).";

// Named individually so write-path allowlist overrides can recompose
// `generalCustomSyntaxRestrictions` minus this set (`.includes` by reference).
const selectByIdImport = {
  selector:
    "ImportSpecifier[imported.type='Identifier'][imported.name='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdQuotedImport = {
  selector:
    "ImportSpecifier[imported.type='Literal'][imported.value='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdMember = {
  selector: "MemberExpression[computed=false][property.name='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdComputedLiteral = {
  selector:
    "MemberExpression[computed=true][property.type='Literal'][property.value='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdComputedTemplate = {
  selector:
    "MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdDestructure = {
  selector:
    "ObjectPattern > Property[key.type='Identifier'][key.name='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdDestructureLiteral = {
  selector:
    "ObjectPattern > Property[key.type='Literal'][key.value='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};
const selectByIdDestructureTemplate = {
  selector:
    "ObjectPattern > Property[key.type='TemplateLiteral'][key.quasis.0.value.cooked='selectById']",
  message: SELECT_BY_ID_MESSAGE,
};

export const selectByIdRestrictions = [
  selectByIdImport,
  selectByIdQuotedImport,
  selectByIdMember,
  selectByIdComputedLiteral,
  selectByIdComputedTemplate,
  selectByIdDestructure,
  selectByIdDestructureLiteral,
  selectByIdDestructureTemplate,
];

/**
 * NO FILE MAY CALL `selectById`, and there is no allowlist any more.
 *
 * `selectById` died with the T2 directory mirror (P4.2 Leg 3) - the method is
 * gone from `IHostDirectoryService` and from its implementation, and the
 * authority bridge that was once its single sanctioned caller now publishes to
 * the selection store instead. The write-path allowlist that named that bridge
 * went with it: an allowlist permitting a call nobody can make is dead config
 * wearing the costume of protection.
 *
 * The restrictions below are KEPT as a tripwire. Re-adding a selection write to
 * the directory service is a redesign-level change - it means re-adding the
 * method to the interface AND an implementation - not an allowlist edit, and it
 * would rebuild the second-decider defect the audit found.
 */

const SELECTION_AUTHORITY_MESSAGE =
  "The selection authority client (`runnerHost.selectionAuthority`) is the preferred-host WRITE API. Only the Settings activate module may reach it, plus the one renderer bridge that mounts the evidence kernel. See " +
  HOST_SELECTION_REDESIGN_PLAN +
  " (selection model §5).";

const selectionAuthorityMember = {
  selector:
    "MemberExpression[computed=false][property.name='selectionAuthority']",
  message: SELECTION_AUTHORITY_MESSAGE,
};

const selectionAuthorityComputedLiteral = {
  selector:
    "MemberExpression[computed=true][property.type='Literal'][property.value='selectionAuthority']",
  message: SELECTION_AUTHORITY_MESSAGE,
};

const selectionAuthorityDestructure = {
  selector:
    "ObjectPattern > Property[key.type='Identifier'][key.name='selectionAuthority']",
  message: SELECTION_AUTHORITY_MESSAGE,
};

/** D12 write path, upper half: who may reach the preferred-write API. */
export const selectionAuthorityRestrictions = [
  selectionAuthorityMember,
  selectionAuthorityComputedLiteral,
  selectionAuthorityDestructure,
];

/**
 * Files that may touch `runnerHost.selectionAuthority`.
 */
export const selectionAuthorityWriteAllowlist = [
  // Settings ▸ Activate: the one UI writer of `preferredHostId`.
  "src/components/settings/host-scope/use-host-scope.ts",
  // Composition root: hands the client to the bridge it mounts. Deliberately
  // NOT the bridge itself - the bridge takes the client as an option and can
  // therefore keep the ban, which is what makes this list read as "who may
  // reach for the write API", not "who is in the selection layer".
  "src/providers/host-runtime-provider.tsx",
];

/**
 * Read-path allowlist. Every entry is a directory or file that may import
 * `useAddressableHostId` / `useHostClient` / `useDefaultHostClient`.
 * Tab-content trees are deliberately absent.
 */
export const hostSelectionReadAllowlist = [
  // Host-layer adapters + default-client wrapper hook layer.
  "src/hooks/**/*.{ts,tsx}",
  "src/lib/host/**/*.{ts,tsx}",

  // Feeds
  "src/stores/notifications/**/*.{ts,tsx}",
  "src/components/notifications/**/*.{ts,tsx}",

  // Landing
  "src/components/home/**/*.{ts,tsx}",

  // Epic-session registry
  "src/providers/epic-session-provider.tsx",
  "src/providers/epic-tab-existence-reconciler.tsx",
  "src/providers/chat-records-stream-mount.tsx",
  "src/lib/registries/**/*.{ts,tsx}",
  // Selector surface over OpenEpicStore — canvas-serving (D4), not tab-pinned.
  "src/lib/epic-selectors.ts",

  // App chrome (layout, settings, providers, palette, sidebar lists, canvas shell)
  "src/components/layout/**/*.{ts,tsx}",
  "src/components/settings/**/*.{ts,tsx}",
  "src/providers/**/*.{ts,tsx}",
  "src/lib/commands/**/*.{ts,tsx}",
  "src/components/epic-canvas/sidebar/**/*.{ts,tsx}",
  "src/components/epic-canvas/hooks/**/*.{ts,tsx}",
  "src/components/epic-canvas/canvas/**/*.{ts,tsx}",
  "src/components/epic-canvas/panels/epic-sharing/**/*.{ts,tsx}",
  "src/components/migration/**/*.{ts,tsx}",
  "src/stores/settings/**/*.{ts,tsx}",

  // Cross-host fork (#1227): the dialog's cloud-owner read deliberately
  // shares the sidebar's cloud-chat query cache, which is keyed by the
  // app-wide client - a tab-client read would fork the cache entry per host
  // to answer the same cloud fact. Host-scoped RPCs in this dialog still
  // ride the tab client and per-row requesters. A single file, not the
  // chat/ directory: the exemption is the read, not the surface.
  "src/components/chat/chat-fork-dialog.tsx",

  // Tests mock / arrange these hooks; the production surface is what D12 polices.
  "**/__tests__/**/*.{ts,tsx}",
  "**/*.{test,spec}.{ts,tsx}",
];

/**
 * The ONE file allowed to name {@link SelectionEvidenceKernel} at runtime
 * (redesign P1.3, review finding F2 half B).
 *
 * A single file, never a directory. The owner lives under `src/lib/host/`, and
 * exempting that directory would silently widen the ban's meaning from "only
 * the owner may construct a kernel" to "only lib/host may" - with any file
 * later dropped in there inheriting the exemption and nobody noticing.
 */
export const selectionKernelOwner = [
  "src/lib/host/renderer-selection-kernel.ts",
];

const SELECTION_KERNEL_MESSAGE =
  "The window's `SelectionEvidenceKernel` is owned by `@/lib/host/renderer-selection-kernel` and acquired through `acquireRendererSelectionKernel(client)`. Constructing another one attaches a second claim against a client that is attach-once per instance, which is terminal for that generation (F2). Transports report through `transportEvidenceRelay`, never through a kernel reference - that single funnel is what lets the relay hold the replay-at-bind inventory. See " +
  HOST_SELECTION_REDESIGN_PLAN +
  " (P1.3 f2-warm-pool-inventory).";

/**
 * Bans naming the kernel outside its owner. `allowTypeImports` is deliberate:
 * the ban targets RUNTIME AUTHORITY, not type references. A consumer that
 * accepts an already-constructed kernel (the selection-authority bridge does)
 * refers to it as a type, which grants nothing and is exactly how a consumer
 * should be written.
 */
export const selectionKernelImportRestrictions = {
  patterns: [
    {
      group: [
        "**/host-selection/selection-evidence-kernel",
        "**/host-selection/selection-evidence-kernel.*",
      ],
      importNames: ["SelectionEvidenceKernel"],
      allowTypeImports: true,
      message: SELECTION_KERNEL_MESSAGE,
    },
  ],
};

export const hostSelectionReadImportRestrictions = {
  // Patterns (not `paths`) so both `@/` aliases and relative imports match
  // once. `importNames` keeps type-only / unrelated specifiers off the hook.
  patterns: [
    {
      group: ["**/use-addressable-host-id", "**/use-addressable-host-id.*"],
      importNames: ["useAddressableHostId"],
      message: ACTIVE_HOST_READ_MESSAGE,
    },
    {
      group: ["**/lib/host", "**/lib/host/index", "**/lib/host/runtime"],
      importNames: ["useHostClient"],
      message: ACTIVE_HOST_READ_MESSAGE,
    },
    {
      group: ["**/use-gui-harness-catalog", "**/use-gui-harness-catalog.*"],
      importNames: ["useDefaultHostClient"],
      message: ACTIVE_HOST_READ_MESSAGE,
    },
  ],
};
