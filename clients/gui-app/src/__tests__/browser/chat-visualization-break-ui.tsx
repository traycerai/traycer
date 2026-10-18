import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { JsonObject } from "@traycer/protocol/persistence/chat-sync/json";
import type {
  ToolCallMcpAppStamp,
  ToolCallPageStamp,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  EpicFileLocalState,
  EpicFileUnavailableReason,
  EpicReadFileResponse,
  EpicStateFileRecord,
} from "@traycer/protocol/host/epic/files";
import { ChatAttachmentScopeContext } from "@/components/chat/chat-attachment-scope-context";
import { AppMessageDraftPill } from "@/components/chat/composer/app-message-draft-pill";
import { McpAppRow } from "@/components/chat/segments/mcp-app-row";
import { PageRow } from "@/components/chat/segments/page-row";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { FilesPanelBody } from "@/components/epic-canvas/sidebar/files-panel";
import { EpicFileTile } from "@/components/files/epic-file-tile";
import { SandboxLinkConfirm } from "@/components/sandbox/sandbox-link-confirm";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  EpicFileRpcContext,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { McpAppRpcContext, type McpAppRpc } from "@/lib/sandbox/mcp-app-rpc";
import {
  getActiveThemePreset,
  getResolvedTheme,
  subscribeResolvedTheme,
} from "@/lib/theme-applier";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { insertAppMessageDraft } from "@/stores/composer/app-message-draft-store";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/index.css";

/**
 * DEV-ONLY break-ui fixture: every chat-visualization surface, rendered by the
 * REAL components, fed one dataset at a time through the same boundaries
 * production data crosses - the page and app stamps, the fake `EpicFileRpc`
 * and `McpAppRpc` answers, the files lane records in a real epic store, the
 * sandboxed app's own JSON-RPC requests, and the host handshake. No component
 * is edited or restyled here.
 *
 * URL params (a reload keeps them; the bottom bar rewrites them):
 * - `data`: demo | worst | empty | one | huge
 * - `surface`: all | page-row | mcp-app | approval | link-confirm |
 *   download-confirm | file-tile | files-panel | settings
 * - `theme`: light | dark;  `dir`: ltr | rtl;  `chrome=0` hides the bar.
 *
 * `window.__breakUiErrors` collects uncaught errors; `body[data-ready]` is
 * set once the tree has mounted.
 */

type DataSet = "demo" | "worst" | "empty" | "one" | "huge";
type Surface =
  | "all"
  | "page-row"
  | "mcp-app"
  | "approval"
  | "link-confirm"
  | "download-confirm"
  | "file-tile"
  | "files-panel"
  | "settings";

const DATA_SETS: readonly DataSet[] = ["demo", "worst", "empty", "one", "huge"];
const DATA_LABELS: Record<DataSet, string> = {
  demo: "Demo",
  worst: "Worst case",
  empty: "Empty",
  one: "One",
  huge: "Huge",
};
const SURFACES: readonly Surface[] = [
  "all",
  "page-row",
  "mcp-app",
  "approval",
  "link-confirm",
  "download-confirm",
  "file-tile",
  "files-panel",
  "settings",
];

const params = new URLSearchParams(window.location.search);
function pick<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = params.get(name);
  return allowed.find((item) => item === value) ?? fallback;
}
const DATA = pick("data", DATA_SETS, "worst");
const SURFACE = pick("surface", SURFACES, "all");
const THEME = pick("theme", ["light", "dark"], "light");
const DIR = pick("dir", ["ltr", "rtl"], "ltr");
const SHOW_CHROME = params.get("chrome") !== "0";

useSettingsStore.getState().setTheme(THEME);
document.documentElement.dir = DIR;

const EPIC_ID = "epic-break-ui";
const CHAT_ID = "chat-break-ui";
const TAB_ID = "tab-break-ui";
const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const YEAR = 365 * DAY;

// ─── Values ──────────────────────────────────────────────────────────────

/** Deterministic lowercase hex, `n` characters long. */
function hex(seed: number, length: number): string {
  let out = "";
  let state = seed * 2654435761 + 1;
  while (out.length < length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += state.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}
function sha(seed: number): string {
  return hex(seed, 64);
}

/** The host's page path: `files/pages/<slug≤48>-<12 hex>.html` (show-page.ts). */
function pageSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug.length > 0 ? slug : "page";
}
function pagePath(title: string, seed: number): string {
  return `files/pages/${pageSlug(title)}-${hex(seed, 12)}.html`;
}

const TITLE_LONG =
  "Q3 2026 revenue forecast by region, product line and sales channel — Northwind Industries Holdings (EMEA, APAC, LATAM, North America) with churn-adjusted ARR, pipeline coverage and FX sensitivity".slice(
    0,
    200,
  );
const TITLE_JA =
  "第3四半期の地域別売上予測ダッシュボード（北米・欧州・アジア太平洋）";
const TITLE_AR = "توقعات الإيرادات للربع الثالث حسب المنطقة وخط الإنتاج";
const TITLE_EMOJI = "📈 Pipeline coverage, week 37";
const TITLE_DEMO = "Revenue by region";

const SERVER_LONG = "northwind-industries-internal-analytics-mcp";
const TOOL_LONG = "generate_quarterly_revenue_forecast_dashboard";

const LONG_URL =
  "https://analytics.northwind-industries-holdings.example.com/workspaces/emea-finance/dashboards/q3-2026-revenue-forecast/views/9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f?tab=regions&filter=region%3DEMEA%2CAPAC%2CLATAM&compare=previous_quarter&currency=EUR&utm_source=traycer&utm_medium=mcp-app&utm_campaign=q3-board-review";
/** The bridge's 8 KiB cap, filled with a realistic encoded view state. */
function urlAtCap(): string {
  const base = `${LONG_URL}&state=`;
  let state = "";
  let seed = 1;
  while (base.length + state.length < 8 * 1024) {
    state += encodeURIComponent(
      `{"panel":"region-${String(seed)}","series":["arr","nrr","churn"],"range":"2026-07-01..2026-09-30"}`,
    );
    seed += 1;
  }
  return (base + state).slice(0, 8 * 1024);
}

const MIB = 1024 * 1024;
const SIZE_NEAR_CAP = Math.round(499.9 * MIB);

// ─── Page HTML (agent-authored bodies, kept small) ───────────────────────

function pageHtml(title: string, rows: number): string {
  const bars = Array.from(
    { length: rows },
    (_, index) =>
      `<div style="display:flex;gap:8px;align-items:center"><span style="width:80px">Region ${String(index + 1)}</span><span style="height:10px;width:${String(30 + ((index * 37) % 60))}%;background:#3b82f6;border-radius:3px"></span></div>`,
  ).join("");
  return `<!doctype html><html><body style="margin:0;font:13px system-ui;padding:12px;display:flex;flex-direction:column;gap:6px"><h3 style="margin:0 0 6px">${title.replace(/</g, "&lt;")}</h3>${bars}</body></html>`;
}
/** Throws before painting anything, with the browser's default body margin. */
const CRASHING_HTML = `<script>throw new Error("chart library failed to load");</script>`;
/** The same, with a zero-height body: the frame reports it crashed. */
const CRASHING_ZERO_HTML = `<html><body style="margin:0"><script>throw new Error("chart library failed to load");</script></body></html>`;

function appHtml(body: string, script: string): string {
  return `<main style="padding:12px;font:13px system-ui">${body}</main>
<script>
let next = 0;
function ask(method, params) {
  parent.postMessage({ jsonrpc: "2.0", id: "app-" + (++next), method, params }, "*");
}
setTimeout(() => {
${script}
}, 600);
</script>`;
}

// ─── Files lane records ──────────────────────────────────────────────────

interface FileSpec {
  readonly path: string;
  readonly sha256: string;
  readonly kind: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly createdAt: number;
  readonly derivedFrom: string | null;
  readonly title: string | null;
  readonly localState: EpicFileLocalState;
}

function record(spec: FileSpec): EpicStateFileRecord {
  return {
    path: spec.path,
    entry: {
      v: 1,
      kind: spec.kind,
      sha256: spec.sha256,
      byteLength: spec.byteLength,
      mediaType: spec.mediaType,
      status: "published",
      createdAt: spec.createdAt,
      derivedFrom: spec.derivedFrom,
      deletedAt: null,
      title: spec.title,
    },
    localState: spec.localState,
  };
}

const PRESENT: EpicFileLocalState = { kind: "present" };
const ABSENT: EpicFileLocalState = { kind: "absent" };

function pageRecord(
  title: string,
  seed: number,
  createdAt: number,
  derivedFrom: string | null,
): EpicStateFileRecord {
  return record({
    path: pagePath(title, seed),
    sha256: sha(seed),
    kind: "page",
    byteLength: 18_400 + seed,
    mediaType: "text/html",
    createdAt,
    derivedFrom,
    title,
    localState: PRESENT,
  });
}

/** An edited page's whole chain: `count` versions, oldest first. */
function versionChain(
  title: string,
  firstSeed: number,
  count: number,
): readonly EpicStateFileRecord[] {
  const chain: EpicStateFileRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const previous = chain.at(-1);
    chain.push(
      pageRecord(
        title,
        firstSeed + index,
        NOW - (count - index) * 3 * DAY,
        previous === undefined
          ? null
          : `${previous.path}@${previous.entry.sha256}`,
      ),
    );
  }
  return chain;
}

function fileRecord(spec: {
  readonly path: string;
  readonly seed: number;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly createdAt: number;
  readonly localState: EpicFileLocalState;
}): EpicStateFileRecord {
  return record({
    path: spec.path,
    sha256: sha(spec.seed),
    kind: "file",
    byteLength: spec.byteLength,
    mediaType: spec.mediaType,
    createdAt: spec.createdAt,
    derivedFrom: null,
    title: null,
    localState: spec.localState,
  });
}

function appRecord(
  stamp: ToolCallMcpAppStamp,
  createdAt: number,
): EpicStateFileRecord {
  return record({
    path: stamp.snapshot.path,
    sha256: stamp.snapshot.sha256,
    kind: "mcp-app",
    byteLength: 42_118,
    mediaType: "text/html",
    createdAt,
    derivedFrom: null,
    title: `${stamp.server} · ${stamp.tool}`,
    localState: PRESENT,
  });
}

// ─── The fake file reads, keyed by sha ───────────────────────────────────

type FileBody =
  | { readonly kind: "html"; readonly html: string }
  | {
      readonly kind: "bytes";
      readonly mediaType: string;
      readonly bytes: () => Promise<Uint8Array>;
    }
  | { readonly kind: "unavailable"; readonly reason: EpicFileUnavailableReason }
  | { readonly kind: "pending" }
  | { readonly kind: "reject" };

const bodies = new Map<string, FileBody>();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function pngBytes(
  width: number,
  height: number,
  label: string,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#0ea5e9");
    gradient.addColorStop(1, "#a855f7");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#fff";
    context.font = `${String(Math.max(14, Math.round(height / 6)))}px system-ui`;
    context.fillText(label, 16, height / 2);
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

function pdfBytes(title: string): Uint8Array {
  const text = title.replace(/[()\\]/g, "");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${String(44 + text.length)} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const never = new Promise<never>(() => undefined);

const fileRpc: EpicFileRpc = {
  readFile: async (request): Promise<EpicReadFileResponse> => {
    const body = bodies.get(request.sha256) ?? {
      kind: "unavailable",
      reason: "missing",
    };
    if (body.kind === "pending") return never;
    if (body.kind === "reject") throw new Error("socket hang up");
    if (body.kind === "unavailable") {
      return { kind: "unavailable", reason: body.reason };
    }
    if (body.kind === "html") {
      return {
        kind: "text",
        text: body.html,
        mediaType: "text/html",
        networkPolicy: "https-only",
      };
    }
    if (request.want.kind !== "range") {
      return { kind: "unavailable", reason: "upload-pending" };
    }
    const bytes = await body.bytes();
    const { offset, length } = request.want;
    return {
      kind: "bytes",
      bytesBase64: base64(bytes.subarray(offset, offset + length)),
      offset,
      totalBytes: bytes.length,
      mediaType: body.mediaType,
    };
  },
  fetchFile: () => Promise.resolve({ kind: "downloading" }),
  cancelFetchFile: () => Promise.resolve({ cancelled: true }),
};

// ─── Datasets ────────────────────────────────────────────────────────────

interface PageCase {
  readonly label: string;
  readonly page: ToolCallPageStamp | null;
  readonly title: string | null;
  readonly error: string | null;
  readonly isStreaming: boolean;
  readonly startedAt: number;
}

interface AppCase {
  readonly label: string;
  readonly stamp: ToolCallMcpAppStamp;
}

interface Dataset {
  readonly pages: readonly PageCase[];
  readonly apps: readonly AppCase[];
  readonly drafts: readonly string[];
  readonly approval: {
    readonly server: string;
    readonly tool: string;
    readonly title: string;
    readonly args: JsonObject;
  };
  readonly linkUrl: string;
  readonly downloads: readonly JsonObject[];
  readonly tiles: readonly {
    readonly label: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly records: readonly EpicStateFileRecord[];
  readonly served: boolean;
  readonly hostLabel: string;
}

function stampFor(
  rec: EpicStateFileRecord,
  title: string,
  derivedFrom: string | null,
): ToolCallPageStamp {
  return {
    path: rec.path,
    sha256: rec.entry.sha256,
    title,
    height: 220,
    heights: [{ width: 768, height: 220 }],
    derivedFrom,
    originChatId: CHAT_ID,
  };
}

/** A page row case with its own record and read answer. */
function shownPage(
  records: EpicStateFileRecord[],
  spec: {
    readonly label: string;
    readonly title: string;
    readonly seed: number;
    readonly body: FileBody;
    readonly localState: EpicFileLocalState;
    readonly byteLength: number;
  },
): PageCase {
  const rec = record({
    path: pagePath(spec.title, spec.seed),
    sha256: sha(spec.seed),
    kind: "page",
    byteLength: spec.byteLength,
    mediaType: "text/html",
    createdAt: NOW - spec.seed * MINUTE,
    derivedFrom: null,
    title: spec.title,
    localState: spec.localState,
  });
  records.push(rec);
  bodies.set(rec.entry.sha256, spec.body);
  return {
    label: spec.label,
    page: stampFor(rec, spec.title, null),
    title: spec.title,
    error: null,
    isStreaming: false,
    startedAt: NOW,
  };
}

function building(
  label: string,
  title: string | null,
  startedAt: number,
): PageCase {
  return {
    label,
    page: null,
    title,
    error: null,
    isStreaming: true,
    startedAt,
  };
}
function failed(label: string, error: string): PageCase {
  return {
    label,
    page: null,
    title: null,
    error,
    isStreaming: false,
    startedAt: NOW,
  };
}

interface AppSpec {
  readonly label: string;
  readonly server: string;
  readonly tool: string;
  readonly seed: number;
  readonly prefersBorder: boolean;
  readonly body: FileBody;
}

function appStamp(spec: Omit<AppSpec, "label">): ToolCallMcpAppStamp {
  const snapshotSha = sha(spec.seed);
  bodies.set(snapshotSha, spec.body);
  return {
    server: spec.server,
    tool: spec.tool,
    resourceUri: `ui://${spec.server}/app`,
    snapshot: {
      path: `files/mcp-apps/${snapshotSha}.html`,
      sha256: snapshotSha,
    },
    csp: null,
    permissions: [],
    prefersBorder: spec.prefersBorder,
    toolInput: {},
    toolResult: { content: [] },
    source: {
      originChatId: CHAT_ID,
      harnessId: "claude",
      nativeSessionId: "session-1",
      serverKey: sha(9000 + spec.seed),
    },
    modelContext: null,
  };
}

function appCase(spec: AppSpec): AppCase {
  return { label: spec.label, stamp: appStamp(spec) };
}

function plainApp(label: string): FileBody {
  return {
    kind: "html",
    html: appHtml(
      `<div style="height:120px;display:grid;place-items:center;border-radius:8px;background:#f1f5f9;color:#0f172a">${label}</div>`,
      "",
    ),
  };
}
/** Calls a tool on load; the fake host never answers, so the row is waking. */
const WAKING_APP: FileBody = {
  kind: "html",
  html: appHtml(
    `<div style="height:80px">waiting for the server</div>`,
    `ask("tools/call", { name: "refresh", arguments: {} });`,
  ),
};
/** Reads a resource on load; the host answers that the session changed. */
const UNREACHABLE_APP: FileBody = {
  kind: "html",
  html: appHtml(
    `<div style="height:80px">last result</div>`,
    `ask("resources/read", { uri: "ui://session-changed" });`,
  ),
};

function deepArgs(depth: number, width: number): JsonObject {
  const out: JsonObject = {};
  for (let index = 0; index < width; index += 1) {
    const key = `region_${["emea", "apac", "latam", "na", "anz"][index % 5] ?? "x"}_${String(index)}`;
    out[key] =
      depth <= 0
        ? `Forecast note for ${key}: includes churn-adjusted ARR, FX at 1.0842 EUR/USD, see ${LONG_URL}`
        : deepArgs(depth - 1, Math.max(2, width - 2));
  }
  return out;
}

function buildDataset(ds: DataSet): Dataset {
  const records: EpicStateFileRecord[] = [];
  const pages = buildPages(ds, records);
  const apps = APP_SPECS[ds]().map(appCase);
  for (const app of apps) records.push(appRecord(app.stamp, NOW - 2 * DAY));
  const tiles = buildTiles(ds, records);
  records.push(...PANEL_EXTRAS[ds]());
  return {
    pages,
    apps,
    drafts: DRAFTS[ds],
    approval: APPROVALS[ds](),
    linkUrl: LINK_URLS[ds](),
    downloads: DOWNLOADS[ds](),
    tiles,
    records: ds === "empty" ? [] : records,
    served: true,
    hostLabel: HOST_LABELS[ds],
  };
}

// Page row states. Each `shownPage` adds its record and its read answer.
function buildPages(
  ds: DataSet,
  records: EpicStateFileRecord[],
): readonly PageCase[] {
  if (ds === "empty") {
    return [
      building("building, no title", null, NOW),
      failed("failed, blank error", " "),
      shownPage(records, {
        label: "rendered, empty title",
        title: "",
        seed: 101,
        body: { kind: "html", html: "" },
        localState: PRESENT,
        byteLength: 0,
      }),
    ];
  }
  if (ds === "one") {
    return [
      shownPage(records, {
        label: "rendered",
        title: "J",
        seed: 101,
        body: { kind: "html", html: pageHtml("J", 1) },
        localState: PRESENT,
        byteLength: 1,
      }),
    ];
  }
  const worst = ds === "worst";
  const title = ds === "demo" ? TITLE_DEMO : TITLE_LONG;
  const size = ds === "demo" ? Math.round(14.2 * MIB) : SIZE_NEAR_CAP;
  const pages: PageCase[] = [
    building("building", title, worst ? NOW - 3 * 60 * MINUTE : NOW),
    failed(
      "failed",
      worst
        ? "Error: page html is 612,388 characters; traycer_show_page accepts at most 512,000. Split the dashboard into several pages or move the raw data to files/uploads/q3-2026-revenue-forecast-by-region-and-product-line.csv"
        : "Error: html is empty",
    ),
  ];
  const chain = versionChain(title, 300, worst ? 12 : 2);
  records.push(...chain);
  for (const rec of chain) {
    bodies.set(rec.entry.sha256, { kind: "html", html: pageHtml(title, 4) });
  }
  const latest = chain.at(-1);
  const previous = chain.at(-2);
  if (latest !== undefined && previous !== undefined) {
    pages.push({
      label: "rendered + derived caption (hover for the bar)",
      page: stampFor(
        latest,
        title,
        `${previous.path}@${previous.entry.sha256}`,
      ),
      title,
      error: null,
      isStreaming: false,
      startedAt: NOW,
    });
  }
  const scripts = worst
    ? [
        { label: "rendered, Japanese title", title: TITLE_JA },
        { label: "rendered, Arabic title", title: TITLE_AR },
        { label: "rendered, emoji-first title", title: TITLE_EMOJI },
      ]
    : [];
  scripts.forEach((item, index) => {
    pages.push(
      shownPage(records, {
        label: item.label,
        title: item.title,
        seed: 102 + index,
        body: { kind: "html", html: pageHtml(item.title, 3) },
        localState: PRESENT,
        byteLength: 18_400,
      }),
    );
  });
  const states: readonly {
    readonly label: string;
    readonly body: FileBody;
    readonly localState: EpicFileLocalState;
  }[] = [
    {
      label: "loading skeleton",
      body: { kind: "pending" },
      localState: PRESENT,
    },
    {
      label: "not downloaded",
      body: unavailable("not-downloaded"),
      localState: ABSENT,
    },
    {
      label: "copying, with progress",
      body: unavailable("not-downloaded"),
      localState: {
        kind: "downloading",
        received: Math.round(size * 0.37),
        total: size,
      },
    },
    {
      label: "copy failed (Retry)",
      body: unavailable("failed"),
      localState: ABSENT,
    },
    {
      label: "upload-pending",
      body: unavailable("upload-pending"),
      localState: ABSENT,
    },
    { label: "missing", body: unavailable("missing"), localState: ABSENT },
    {
      label: "local-only",
      body: unavailable("local-only"),
      localState: ABSENT,
    },
    {
      label: "read error (Retry)",
      body: { kind: "reject" },
      localState: PRESENT,
    },
    {
      label: "script throws, default body margin",
      body: { kind: "html", html: CRASHING_HTML },
      localState: PRESENT,
    },
    {
      label: "crashed (script throws, zero-height body)",
      body: { kind: "html", html: CRASHING_ZERO_HTML },
      localState: PRESENT,
    },
  ];
  states.forEach((state, index) => {
    pages.push(
      shownPage(records, {
        label: state.label,
        title,
        seed: 110 + index,
        body: state.body,
        localState: state.localState,
        byteLength: size,
      }),
    );
  });
  const extra = ds === "huge" ? 24 : 0;
  for (let index = 0; index < extra; index += 1) {
    const each = `${TITLE_DEMO} ${String(index + 1)}`;
    pages.push(
      shownPage(records, {
        label: `rendered #${String(index + 1)}`,
        title: each,
        seed: 200 + index,
        body: { kind: "html", html: pageHtml(each, 3) },
        localState: PRESENT,
        byteLength: 18_400,
      }),
    );
  }
  return pages;
}

function unavailable(reason: EpicFileUnavailableReason): FileBody {
  return { kind: "unavailable", reason };
}

// MCP App rows.
const APP_SPECS: Record<DataSet, () => readonly AppSpec[]> = {
  demo: () => [
    {
      label: "border on",
      server: "linear",
      tool: "create_issue",
      seed: 500,
      prefersBorder: true,
      body: plainApp("Issue LIN-482 created"),
    },
    {
      label: "border off",
      server: "figma",
      tool: "get_design",
      seed: 501,
      prefersBorder: false,
      body: plainApp("Frame: Checkout v3"),
    },
    {
      label: "waking",
      server: "linear",
      tool: "refresh",
      seed: 502,
      prefersBorder: true,
      body: WAKING_APP,
    },
    {
      label: "unreachable",
      server: "linear",
      tool: "list_issues",
      seed: 503,
      prefersBorder: true,
      body: UNREACHABLE_APP,
    },
  ],
  worst: () => [
    {
      label: "long server + tool, border on",
      server: SERVER_LONG,
      tool: TOOL_LONG,
      seed: 500,
      prefersBorder: true,
      body: plainApp("Q3 forecast"),
    },
    {
      label: "long server + tool, border off",
      server: SERVER_LONG,
      tool: TOOL_LONG,
      seed: 501,
      prefersBorder: false,
      body: plainApp("Q3 forecast"),
    },
    {
      label: "Japanese server",
      server: "ノースウィンド分析サーバー",
      tool: "売上予測を表示",
      seed: 502,
      prefersBorder: true,
      body: plainApp("売上"),
    },
    {
      label: "Arabic server",
      server: "خادم تحليلات نورثويند",
      tool: "عرض_التوقعات",
      seed: 503,
      prefersBorder: false,
      body: plainApp("التوقعات"),
    },
    {
      label: "waking, long server",
      server: SERVER_LONG,
      tool: TOOL_LONG,
      seed: 504,
      prefersBorder: true,
      body: WAKING_APP,
    },
    {
      label: "unreachable (session changed), long server",
      server: SERVER_LONG,
      tool: TOOL_LONG,
      seed: 505,
      prefersBorder: true,
      body: UNREACHABLE_APP,
    },
    {
      label: "loading skeleton",
      server: SERVER_LONG,
      tool: TOOL_LONG,
      seed: 506,
      prefersBorder: true,
      body: { kind: "pending" },
    },
    {
      label: "script throws, default body margin",
      server: SERVER_LONG,
      tool: TOOL_LONG,
      seed: 507,
      prefersBorder: true,
      body: { kind: "html", html: CRASHING_HTML },
    },
    {
      label: "crashed (script throws, zero-height body)",
      server: SERVER_LONG,
      tool: TOOL_LONG,
      seed: 508,
      prefersBorder: true,
      body: { kind: "html", html: CRASHING_ZERO_HTML },
    },
  ],
  empty: () => [
    {
      label: "one-letter server and tool, empty body",
      server: "x",
      tool: "y",
      seed: 500,
      prefersBorder: false,
      body: { kind: "html", html: appHtml("", "") },
    },
  ],
  one: () => [
    {
      label: "one app",
      server: "linear",
      tool: "create_issue",
      seed: 500,
      prefersBorder: true,
      body: plainApp("Issue LIN-1 created"),
    },
  ],
  huge: () =>
    Array.from({ length: 20 }, (_, index) => ({
      label: `app #${String(index + 1)}`,
      server: `analytics-${String(index + 1)}`,
      tool: "show_chart",
      seed: 500 + index,
      prefersBorder: index % 2 === 0,
      body: plainApp(`Chart ${String(index + 1)}`),
    })),
};

// The composer chip: one per app message (D29).
const DRAFTS: Record<DataSet, readonly string[]> = {
  demo: ["linear"],
  worst: [SERVER_LONG, "ノースウィンド分析サーバー", "خادم تحليلات نورثويند"],
  empty: ["x"],
  one: ["linear"],
  huge: ["analytics-1", "analytics-2", "analytics-3"],
};

// The approval card.
function longApproval(depth: number, width: number): Dataset["approval"] {
  return {
    server: SERVER_LONG,
    tool: TOOL_LONG,
    title:
      "Write 1,284 forecast rows to the Northwind data warehouse (finance.q3_2026_revenue_forecast) for every region, product line and sales channel, replacing the rows from the previous run",
    args: deepArgs(depth, width),
  };
}
const DEMO_APPROVAL: Dataset["approval"] = {
  server: "linear",
  tool: "create_issue",
  title: "Create an issue",
  args: { title: "Checkout button misaligned", team: "WEB" },
};
const APPROVALS: Record<DataSet, () => Dataset["approval"]> = {
  demo: () => DEMO_APPROVAL,
  worst: () => longApproval(2, 6),
  empty: () => ({ server: "x", tool: "y", title: "", args: {} }),
  one: () => DEMO_APPROVAL,
  huge: () => longApproval(3, 9),
};

const LINK_URLS: Record<DataSet, () => string> = {
  demo: () => "https://linear.app/northwind/issue/LIN-482",
  worst: urlAtCap,
  empty: () => "https://a.co/",
  one: () => LONG_URL,
  huge: urlAtCap,
};

function embedded(name: string, text: string): JsonObject {
  return {
    type: "resource",
    resource: {
      uri: `ui://exports/${encodeURIComponent(name)}`,
      mimeType: "text/plain",
      text,
    },
  };
}
function link(
  name: string | null,
  url: string,
  size: number | null,
): JsonObject {
  const item: JsonObject = { type: "resource_link", uri: url };
  if (name !== null) item.name = name;
  if (size !== null) item.size = size;
  return item;
}
const DOWNLOADS: Record<DataSet, () => JsonObject[]> = {
  demo: () => [
    embedded("forecast.csv", "region,arr\nemea,1"),
    link(
      "full-export.parquet",
      "https://exports.example.com/q3.parquet",
      Math.round(14.2 * MIB),
    ),
  ],
  worst: () => [
    embedded(
      "Q3 Board Deck — FINAL (revised) v12 [approved by legal] — Northwind Industries Holdings EMEA APAC LATAM North America revenue forecast with churn-adjusted ARR and FX sensitivity appendix.pdf",
      "x".repeat(2048),
    ),
    embedded("IMG_20250914_183022_HDR_portrait_edited_edited.HEIC", ""),
    embedded("a", "a"),
    link(
      "q3-2026-revenue-forecast-by-region-and-product-line-full-export.parquet",
      LONG_URL,
      SIZE_NEAR_CAP,
    ),
    link(null, `${LONG_URL}&format=csv`, null),
  ],
  empty: () => [],
  one: () => [embedded("forecast.csv", "region,arr\nemea,1")],
  huge: () =>
    Array.from({ length: 40 }, (_, index) =>
      link(
        `region-${String(index + 1)}-forecast.csv`,
        `${LONG_URL}&region=${String(index + 1)}`,
        1_284 * (index + 1),
      ),
    ),
};

// Epic-file tiles, each over its own record and read answer.
function buildTiles(
  ds: DataSet,
  records: EpicStateFileRecord[],
): Dataset["tiles"] {
  const tiles: { label: string; path: string; sha256: string }[] = [];
  const tile = (
    label: string,
    rec: EpicStateFileRecord,
    body: FileBody | null,
  ): void => {
    if (!records.includes(rec)) records.push(rec);
    if (body !== null) bodies.set(rec.entry.sha256, body);
    tiles.push({ label, path: rec.path, sha256: rec.entry.sha256 });
  };
  const worst = ds === "worst";
  if (ds !== "empty" && ds !== "one") {
    const chainTip = records.findLast((rec) => rec.entry.derivedFrom !== null);
    if (chainTip !== undefined)
      tile("page, newest of the chain", chainTip, null);
    const first = records.find((rec) => rec.entry.sha256 === sha(300));
    if (first !== undefined && worst)
      tile("page, version 1 of the chain", first, null);
  }
  tile(
    "image",
    fileRecord({
      path: worst
        ? "files/uploads/customer-feedback-from-enterprise-onboarding/2026/q3/interviews/IMG_20250914_183022_HDR_portrait_edited_edited_northwind_site_visit_panorama.png"
        : "files/uploads/checkout.png",
      seed: 700,
      byteLength: worst ? 3_912_448 : 182_311,
      mediaType: "image/png",
      createdAt: NOW - 3 * YEAR,
      localState: PRESENT,
    }),
    {
      kind: "bytes",
      mediaType: "image/png",
      bytes: () =>
        worst
          ? pngBytes(4000, 200, "panorama 4000×200")
          : pngBytes(1200, 700, "checkout"),
    },
  );
  if (ds === "empty" || ds === "one") return tiles;
  tile(
    "pdf",
    fileRecord({
      path: worst
        ? "files/uploads/Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf"
        : "files/uploads/board-deck.pdf",
      seed: 701,
      byteLength: 2_048,
      mediaType: "application/pdf",
      createdAt: NOW - 12 * DAY,
      localState: PRESENT,
    }),
    {
      kind: "bytes",
      mediaType: "application/pdf",
      bytes: () => Promise.resolve(pdfBytes(TITLE_DEMO)),
    },
  );
  tile(
    "video, not downloaded",
    fileRecord({
      path: worst
        ? "files/uploads/site-walkthrough-northwind-emea-warehouse-2026-09-14-full-resolution.mp4"
        : "files/uploads/walkthrough.mp4",
      seed: 702,
      byteLength: worst ? SIZE_NEAR_CAP : Math.round(48 * MIB),
      mediaType: "video/mp4",
      createdAt: NOW - 40 * DAY,
      localState: ABSENT,
    }),
    unavailable("not-downloaded"),
  );
  tile(
    "video copying, with progress",
    fileRecord({
      path: "files/uploads/warehouse-walkthrough-copying.mp4",
      seed: 703,
      byteLength: SIZE_NEAR_CAP,
      mediaType: "video/mp4",
      createdAt: NOW,
      localState: {
        kind: "downloading",
        received: Math.round(SIZE_NEAR_CAP * 0.62),
        total: SIZE_NEAR_CAP,
      },
    }),
    unavailable("not-downloaded"),
  );
  tile(
    "no viewer",
    fileRecord({
      path: "files/q3-2026-revenue-forecast-by-region-and-product-line-full-export.parquet",
      seed: 704,
      byteLength: 0,
      mediaType: "application/octet-stream",
      createdAt: NOW,
      localState: PRESENT,
    }),
    null,
  );
  return tiles;
}

// Files panel extras: uploads, folders, root files, identical names.
const PANEL_EXTRAS: Record<DataSet, () => EpicStateFileRecord[]> = {
  demo: () => [
    fileRecord({
      path: "files/uploads/notes.md",
      seed: 710,
      byteLength: 1_204,
      mediaType: "text/markdown",
      createdAt: NOW - 2 * 60 * MINUTE,
      localState: PRESENT,
    }),
    pageRecord("Pipeline coverage", 801, NOW - 5 * 60 * MINUTE, null),
  ],
  worst: () => [
    fileRecord({
      path: "files/uploads/empty.txt",
      seed: 710,
      byteLength: 0,
      mediaType: "text/plain",
      createdAt: NOW,
      localState: PRESENT,
    }),
    fileRecord({
      path: "files/uploads/a",
      seed: 711,
      byteLength: 1,
      mediaType: "text/plain",
      createdAt: NOW - MINUTE,
      localState: PRESENT,
    }),
    fileRecord({
      path: "files/customer-feedback-from-enterprise-onboarding/2026/q3/interviews/Aleksandra Wiśniewska-Kowalczyk — onboarding interview notes (translated from Polish).md",
      seed: 712,
      byteLength: 9_812,
      mediaType: "text/markdown",
      createdAt: NOW - 2 * YEAR,
      localState: ABSENT,
    }),
    fileRecord({
      path: "files/Benachrichtigungseinstellungen-Exportdatei-final-final.csv",
      seed: 713,
      byteLength: 88,
      mediaType: "text/csv",
      createdAt: NOW - 11 * 30 * DAY,
      localState: PRESENT,
    }),
    fileRecord({
      path: "files/notes.md",
      seed: 714,
      byteLength: 120,
      mediaType: "text/markdown",
      createdAt: NOW - 3 * YEAR,
      localState: PRESENT,
    }),
    ...Array.from({ length: 4 }, (_, index) =>
      pageRecord(
        index % 2 === 0 ? TITLE_JA : TITLE_AR,
        800 + index,
        NOW - index * MINUTE,
        null,
      ),
    ),
  ],
  empty: () => [],
  one: () => [],
  huge: () =>
    Array.from({ length: 1_284 }, (_, index) =>
      pageRecord(
        `${TITLE_DEMO} ${String(index + 1)}`,
        10_000 + index,
        NOW - index * 17 * MINUTE,
        null,
      ),
    ),
};

const HOST_LABELS: Record<DataSet, string> = {
  demo: "Anurag's MacBook Pro",
  worst:
    "Aleksandra Wiśniewska-Kowalczyk's MacBook Pro (2) — Northwind build farm, rack 14",
  empty: "",
  one: "J",
  huge: "Anurag's MacBook Pro",
};

const DATASET = buildDataset(DATA);

// ─── Host, epic session and app RPC ──────────────────────────────────────

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const SESSION = openStoreForTest({
  epicId: EPIC_ID,
  userId: null,
  factories: {
    streamClientFactory: noopStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});
SESSION.store.setState({
  files: { served: DATASET.served, records: DATASET.records },
});
getOpenEpicRegistry().acquire(EPIC_ID, () => SESSION);
/** A host that predates the files lane: the panel's "unserved" state. */
const UNSERVED_SESSION = openStoreForTest({
  epicId: `${EPIC_ID}-unserved`,
  userId: null,
  factories: {
    streamClientFactory: noopStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});
const HOST_ID = SESSION.hostId;

const mcpRpc: McpAppRpc = {
  callTool: (request) =>
    SURFACE === "approval"
      ? Promise.resolve(
          request.approvalToken === null
            ? {
                kind: "needsApproval",
                token: "token-1",
                title: DATASET.approval.title,
                args: DATASET.approval.args,
              }
            : { kind: "result", result: { content: [] } },
        )
      : never,
  readResource: () =>
    Promise.resolve({ kind: "error", code: "session-changed", message: null }),
  updateModelContext: () => Promise.resolve({ kind: "updated" }),
};

const runnerHost = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://127.0.0.1:1",
  localHost: {
    hostId: HOST_ID,
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: "0.0.0-fixture",
    pid: 1,
    systemHostName: DATASET.hostLabel,
    displayName: DATASET.hostLabel,
    availability: "available",
  },
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
recordNegotiatedHostMethods(HOST_ID, [
  "config.visualization.get",
  "config.visualization.set",
]);

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `break-ui-${String(++requestCounter)}`,
    handlers: {
      "config.visualization.get": () => ({ agentPages: true }),
      "config.visualization.set": (request) => ({
        agentPages: request.agentPages,
      }),
    },
  });

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

DATASET.drafts.forEach((server, index) => {
  insertAppMessageDraft(
    `${CHAT_ID}-draft-${String(index)}`,
    server,
    "Create an issue for the misaligned checkout button",
  );
});

// ─── The page ────────────────────────────────────────────────────────────

/** Fixture chrome: names the case under it. Not part of any surface. */
export function CaseLabel(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="mb-1 font-mono text-[11px] text-[#8a8f98]" dir="ltr">
      {props.children}
    </div>
  );
}

export function SurfaceSection(props: {
  readonly id: Surface;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  if (SURFACE !== "all" && SURFACE !== props.id) return null;
  return (
    <section data-surface={props.id} className="flex flex-col gap-3 py-4">
      <h2 className="font-mono text-xs text-[#8a8f98]" dir="ltr">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

export function ChatColumn(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      data-container="chat"
      className="mx-auto flex w-full max-w-3xl flex-col gap-5"
    >
      {props.children}
    </div>
  );
}

export function PageRows(): ReactNode {
  return (
    <SurfaceSection id="page-row" title="Agent page row">
      <ChatColumn>
        {DATASET.pages.map((item, index) => (
          <div key={item.label} data-case={`page-${String(index)}`}>
            <CaseLabel>{item.label}</CaseLabel>
            <PageRow
              id={`page-block-${String(index)}`}
              page={item.page}
              inputSummary={null}
              inputDetail={
                item.title === null
                  ? null
                  : {
                      kind: "fields",
                      entries: [
                        { key: "title", label: "Title", value: item.title },
                      ],
                    }
              }
              error={item.error}
              isStreaming={item.isStreaming}
              stopped={false}
              startedAt={item.startedAt}
              fallback={<div className="text-ui-sm">ordinary tool row</div>}
            />
          </div>
        ))}
      </ChatColumn>
    </SurfaceSection>
  );
}

export function AppRows(): ReactNode {
  return (
    <SurfaceSection id="mcp-app" title="MCP App row + composer chip">
      <ChatColumn>
        {DATASET.apps.map((item, index) => (
          <div key={item.label} data-case={`app-${String(index)}`}>
            <CaseLabel>{item.label}</CaseLabel>
            <McpAppRow
              id={`app-block-${String(index)}`}
              app={item.stamp}
              fallback={<div className="text-ui-sm">ordinary tool row</div>}
            />
          </div>
        ))}
        <div data-case="draft-chips">
          <CaseLabel>composer chips (one per app message)</CaseLabel>
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-2">
            {DATASET.drafts.map((server, index) => (
              <div key={server} className="flex flex-wrap gap-1.5">
                <AppMessageDraftPill
                  chatId={`${CHAT_ID}-draft-${String(index)}`}
                />
              </div>
            ))}
          </div>
        </div>
      </ChatColumn>
    </SurfaceSection>
  );
}

function promptingApp(script: string): FileBody {
  return {
    kind: "html",
    html: appHtml(
      `<div style="height:60px">app asking the reader</div>`,
      script,
    ),
  };
}

export function PromptRow(props: {
  readonly surface: Surface;
  readonly body: FileBody;
}): ReactNode {
  const stamp = appStamp({
    server: DATASET.approval.server,
    tool: DATASET.approval.tool,
    seed: 600,
    prefersBorder: true,
    body: props.body,
  });
  return (
    <SurfaceSection id={props.surface} title={props.surface}>
      <ChatColumn>
        <McpAppRow
          id="prompt-block"
          app={stamp}
          fallback={<div className="text-ui-sm">ordinary tool row</div>}
        />
      </ChatColumn>
    </SurfaceSection>
  );
}

const APPROVAL_APP = promptingApp(
  `ask("tools/call", { name: ${JSON.stringify(DATASET.approval.tool)}, arguments: {} });`,
);
const DOWNLOAD_APP = promptingApp(
  `ask("ui/download-file", { contents: ${JSON.stringify(DATASET.downloads)} });`,
);

export function FileTiles(): ReactNode {
  return (
    <SurfaceSection id="file-tile" title="Epic-file tile">
      {DATASET.tiles.map((tile) => (
        <div key={tile.path} data-case={`tile-${tile.label}`}>
          <CaseLabel>{tile.label}</CaseLabel>
          <div
            data-container="tile"
            className="h-[26rem] w-full overflow-hidden rounded-md border border-border"
          >
            <EpicFileTile
              epicId={EPIC_ID}
              node={makeEpicFileTileRef({
                path: tile.path,
                sha256: tile.sha256,
                name: tile.path.slice(tile.path.lastIndexOf("/") + 1),
                hostId: HOST_ID,
                via: null,
              })}
            />
          </div>
        </div>
      ))}
    </SurfaceSection>
  );
}

export function FilesPanel(): ReactNode {
  return (
    <SurfaceSection id="files-panel" title="Files panel">
      <div
        data-container="sidebar"
        className="flex h-[40rem] w-72 flex-col overflow-hidden rounded-md border border-border bg-sidebar text-sidebar-foreground"
      >
        <FilesPanelBody epicId={EPIC_ID} tabId={TAB_ID} />
      </div>
      {DATA === "empty" ? (
        <div
          data-container="sidebar"
          className="flex h-[20rem] w-72 flex-col overflow-hidden rounded-md border border-border bg-sidebar text-sidebar-foreground"
        >
          <EpicSessionContext value={UNSERVED_SESSION}>
            <FilesPanelBody epicId={`${EPIC_ID}-unserved`} tabId={TAB_ID} />
          </EpicSessionContext>
        </div>
      ) : null}
    </SurfaceSection>
  );
}

export function SettingsSurface(): ReactNode {
  return (
    <SurfaceSection id="settings" title="Settings row">
      <div data-container="settings" className="mx-auto w-full max-w-3xl">
        <BrowserSettingsSection
          agentOpenedTabsRow={<div className="hidden" />}
        />
      </div>
    </SurfaceSection>
  );
}

export function ToggleBar(): ReactNode {
  if (!SHOW_CHROME) return null;
  const go = (name: string, value: string): void => {
    const next = new URLSearchParams(window.location.search);
    next.set(name, value);
    window.location.assign(`?${next.toString()}`);
  };
  const segment = (active: boolean): string =>
    active
      ? "rounded-full bg-white px-3 py-1 text-black shadow-sm"
      : "rounded-full px-3 py-1 text-[#555]";
  return (
    <div
      dir="ltr"
      className="fixed bottom-4 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-2 rounded-full bg-[#e4e4e7] p-1 font-sans text-xs"
    >
      {DATA_SETS.map((ds) => (
        <button
          key={ds}
          type="button"
          className={segment(ds === DATA)}
          onClick={() => go("data", ds)}
        >
          {DATA_LABELS[ds]}
        </button>
      ))}
      <select
        aria-label="Surface"
        className="rounded-full bg-white px-2 py-1 text-black"
        value={SURFACE}
        onChange={(event) => go("surface", event.target.value)}
      >
        {SURFACES.map((surface) => (
          <option key={surface} value={surface}>
            {surface}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={segment(false)}
        onClick={() => go("theme", THEME === "dark" ? "light" : "dark")}
      >
        {THEME}
      </button>
      <button
        type="button"
        className={segment(false)}
        onClick={() => go("dir", DIR === "rtl" ? "ltr" : "rtl")}
      >
        {DIR}
      </button>
    </div>
  );
}

export function Fixture(): ReactNode {
  useEffect(() => {
    document.body.dataset.ready = "true";
  }, []);
  return (
    <div className="min-h-dvh bg-background px-4 pb-24 text-foreground">
      <PageRows />
      <AppRows />
      {SURFACE === "approval" ? (
        <PromptRow surface="approval" body={APPROVAL_APP} />
      ) : null}
      {SURFACE === "download-confirm" ? (
        <PromptRow surface="download-confirm" body={DOWNLOAD_APP} />
      ) : null}
      {SURFACE === "link-confirm" ? (
        <SandboxLinkConfirm
          url={DATASET.linkUrl}
          kind="app"
          appName={DATASET.approval.server}
          onDecide={() => undefined}
        />
      ) : null}
      <FileTiles />
      <FilesPanel />
      <SettingsSurface />
      <ToggleBar />
    </div>
  );
}

export function ThemeProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const resolvedTheme = useSyncExternalStore(
    subscribeResolvedTheme,
    getResolvedTheme,
  );
  return (
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme, themePreset: getActiveThemePreset() }}
    >
      {props.children}
    </ResolvedThemeContext.Provider>
  );
}

export function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <ThemeProvider>
              <TooltipProvider>
                <EpicSessionContext value={SESSION}>
                  <TabHostContext value={HOST_ID}>
                    <ChatAttachmentScopeContext.Provider
                      value={{
                        epicId: EPIC_ID,
                        chatId: CHAT_ID,
                        hostId: HOST_ID,
                        hostVersion: null,
                        client: null,
                      }}
                    >
                      <EpicFileRpcContext.Provider value={fileRpc}>
                        <McpAppRpcContext.Provider value={mcpRpc}>
                          {props.children}
                        </McpAppRpcContext.Provider>
                      </EpicFileRpcContext.Provider>
                    </ChatAttachmentScopeContext.Provider>
                  </TabHostContext>
                </EpicSessionContext>
              </TooltipProvider>
            </ThemeProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const fixtureErrors: string[] = [];
window.addEventListener("error", (event) => {
  fixtureErrors.push(
    event.error instanceof Error
      ? (event.error.stack ?? event.message)
      : event.message,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  fixtureErrors.push(
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason),
  );
});
Reflect.set(window, "__breakUiErrors", fixtureErrors);

const rootRoute = createRootRoute({
  component: () => (
    <Providers>
      <Fixture />
    </Providers>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const container = document.getElementById("root");
if (container === null) throw new Error("no #root");
createRoot(container).render(<RouterProvider router={router} />);
