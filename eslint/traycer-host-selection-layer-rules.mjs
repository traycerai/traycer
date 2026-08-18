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
  "Do not import the app-wide host reads (`useAddressableHostId`, `useEffectiveHostId`, `useHostClient`, `useDefaultHostClient`) outside the allowlisted layer (feeds, landing, epic-session registry, app chrome). A tile reads its tab's host (`useTabHostId` / `useTabHostClient`); a surface INSIDE an Epic session - the sidebar, the canvas, its panels, and any hook they mount - reads the session's (`useEpicSessionHostId` / `useEpicSessionHostClient` / `useCanvasHostId`); a picker surface reads its pin (`useSurfaceHostPin`). An app-wide read that is genuinely right where you are is exempted per FILE, with its reason, in the gui-app eslint config. See " +
  HOST_SELECTION_REDESIGN_PLAN +
  " (selection model §5; D15 - the task tab has three host roles).";

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

const selectionAuthorityComputedTemplate = {
  selector:
    "MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked='selectionAuthority']",
  message: SELECTION_AUTHORITY_MESSAGE,
};

const selectionAuthorityDestructure = {
  selector:
    "ObjectPattern > Property[key.type='Identifier'][key.name='selectionAuthority']",
  message: SELECTION_AUTHORITY_MESSAGE,
};

const selectionAuthorityDestructureLiteral = {
  selector:
    "ObjectPattern > Property[key.type='Literal'][key.value='selectionAuthority']",
  message: SELECTION_AUTHORITY_MESSAGE,
};

const selectionAuthorityDestructureTemplate = {
  selector:
    "ObjectPattern > Property[key.type='TemplateLiteral'][key.quasis.0.value.cooked='selectionAuthority']",
  message: SELECTION_AUTHORITY_MESSAGE,
};

/** D12 write path, upper half: who may reach the preferred-write API. */
export const selectionAuthorityRestrictions = [
  selectionAuthorityMember,
  selectionAuthorityComputedLiteral,
  selectionAuthorityComputedTemplate,
  selectionAuthorityDestructure,
  selectionAuthorityDestructureLiteral,
  selectionAuthorityDestructureTemplate,
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
  // NOT `src/lib/epic-selectors.ts`. It was listed here as "canvas-serving
  // (D4), not tab-pinned" - the same two-role premise. Its selectors read the
  // Epic session's handle, so the host that serves them is the handle's own
  // (`getEpicSessionHandleHostId`), never the app-wide one; the one app-wide
  // read it carried stamped every projected record with the wrong host during
  // a re-point (PR #1243, round 6).

  // App chrome (layout, settings, providers, palette, sidebar lists)
  "src/components/layout/**/*.{ts,tsx}",
  "src/components/settings/**/*.{ts,tsx}",
  "src/providers/**/*.{ts,tsx}",
  "src/lib/commands/**/*.{ts,tsx}",
  "src/components/migration/**/*.{ts,tsx}",
  "src/stores/settings/**/*.{ts,tsx}",
  // NOT the Epic canvas subtree. `src/components/epic-canvas/{sidebar,hooks,
  // canvas,panels}` used to be listed here as "canvas shell / app chrome" -
  // the two-role model (tile or app-wide) that this redesign replaced with
  // three (D15): those surfaces are INSIDE an Epic session and read the
  // session's host. Listing them here let ~40 app-wide reads accumulate
  // there and surface as one review finding per push (PR #1243, three
  // rounds of the same class). They now carry `readPath`; the two files in
  // that subtree with a reasoned app-wide read are exempted per FILE in the
  // gui-app config (`epicCanvasAppWideReadExemptions`).

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
    // The selection authority's DERIVED host is an app-wide read too - the
    // one `useAddressableHostId` resolves to when no scoped binding is above
    // it. Left out of this ban until PR #1243, which is how the Epic canvas
    // grew `useEffectiveHostId()` reads the sidebar/canvas ban never saw.
    {
      group: ["**/use-effective-host-id", "**/use-effective-host-id.*"],
      importNames: ["useEffectiveHostId"],
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
