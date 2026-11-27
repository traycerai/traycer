import { useEffect, type ReactNode } from "react";
import { frame } from "motion/react";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { SidebarProvider } from "@/components/ui/sidebar";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { createAppQueryClient } from "@/lib/query-client";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import { FixtureProviders } from "./chat-tree-fixture-providers";
import {
  ROW_QUERY_HANDLERS,
  captureFixtureErrors,
  createFixtureMessengerFactory,
  createFixtureRunnerHost,
  createFixtureSessionHostClient,
  mountFixturePage,
  openFixtureSession,
} from "./chat-tree-fixture-session";
import "@/lib/theme-applier";
import "@/index.css";
/**
 * The REAL `ChatTreePanelBody` over a seeded epic store, for the claims about
 * row motion that only a real layout can decide: which rows slide, fade or
 * snap when the tree changes, and that scrolling animates nothing.
 *
 * `window.__chatTreeMotion` seeds and changes the tree and samples every row's
 * box and opacity once per frame, after Motion has drawn that frame.
 */
const EPIC_ID = "fixture-chat-tree-motion";
const TAB_ID = "tab-chat-tree-motion";
const USER_ID = "viewer-1";
useAuthStore.setState({
  status: "signed-in",
  contextMetadata: { userId: USER_ID, username: USER_ID },
});
function meta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Row motion",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}
function seedDoc(): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  epic.set("title", "Row motion");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
  return Y.encodeStateAsUpdate(donor);
}
const SESSION = openFixtureSession({
  epicId: EPIC_ID,
  userId: USER_ID,
  meta: meta(),
  seedDoc: seedDoc(),
});
/**
 * Root ids and each parent's child ids. The tree sorts newest first, ties by
 * id, so `updatedAt` (an id's activity time, 1 when absent or unlisted) and
 * the ids decide the display order.
 */
interface Shape {
  readonly roots: readonly string[];
  readonly children: Readonly<Record<string, readonly string[]>>;
  readonly updatedAt: Readonly<Record<string, number>> | undefined;
}
function activityOf(shape: Shape, id: string): number {
  return shape.updatedAt?.[id] ?? 1;
}
function node(id: string, parentId: string | null, at: number): TreeNode {
  return {
    id,
    parentId,
    title: `Agent ${id}`,
    type: "chat",
    status: null,
    createdAt: 1,
    updatedAt: at,
  };
}
function chat(id: string, parentId: string | null, at: number): ChatProjection {
  return {
    id,
    title: `Agent ${id}`,
    parentId,
    createdAt: 1,
    updatedAt: at,
    userId: USER_ID,
    ownedByViewer: true,
    hostId: mockLocalHostEntry.hostId,
    isTitleEditedByUser: false,
    docResident: false,
    archivedAt: null,
    settings: null,
  };
}
/**
 * Replaces the tree with `shape`; every listed id is a live chat. `kept` ids
 * stay in the store without a place in the tree, the way a row the filter or
 * the archive hides keeps its node.
 */
function setShape(shape: Shape, kept: readonly string[]): void {
  const nodeById: Record<string, TreeNode> = {};
  const byId: Record<string, ChatProjection> = {};
  const childrenByParent: Record<string, string[]> = {};
  const add = (id: string, parentId: string | null): void => {
    nodeById[id] = node(id, parentId, activityOf(shape, id));
    byId[id] = chat(id, parentId, activityOf(shape, id));
    const kids = shape.children[id] ?? [];
    if (kids.length > 0) childrenByParent[id] = [...kids];
    for (const kid of kids) add(kid, id);
  };
  for (const id of shape.roots) add(id, null);
  for (const id of kept) {
    nodeById[id] = node(id, null, 1);
    byId[id] = chat(id, null, 1);
  }
  SESSION.store.setState({
    tree: { rootIds: [...shape.roots], childrenByParent, nodeById },
    chats: { allIds: Object.keys(byId), byId },
  });
}
interface RowSample {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly opacity: number;
  /** When it was sampled, in ms after the change (0 before it). */
  readonly at: number;
}
const LOCAL_ROW_PREFIX = "epic-sidebar-item-";
const CLOUD_ROW_PREFIX = "epic-sidebar-cloud-item-";
/** The opacity an element is drawn at: its own times every ancestor's. */
function drawnOpacity(element: HTMLElement): number {
  let opacity = 1;
  for (
    let el: HTMLElement | null = element;
    el !== null && el !== document.body;
    el = el.parentElement
  ) {
    opacity *= Number(getComputedStyle(el).opacity);
  }
  return Math.round(opacity * 1000) / 1000;
}
function sampleOf(id: string, element: HTMLElement, at: number): RowSample {
  const box = element.getBoundingClientRect();
  return {
    id,
    top: Math.round(box.top * 10) / 10,
    bottom: Math.round(box.bottom * 10) / 10,
    left: Math.round(box.left * 10) / 10,
    opacity: drawnOpacity(element),
    at,
  };
}
/**
 * Every rendered row's box and drawn opacity, by its chat id (a cloud row by
 * its cloud chat id), and every group rail's, by `rail:` and the row key of
 * the row that owns it.
 */
function sampleRows(at: number): RowSample[] {
  const out: RowSample[] = [];
  for (const button of document.querySelectorAll<HTMLElement>(
    `[data-testid^="${LOCAL_ROW_PREFIX}"], [data-testid^="${CLOUD_ROW_PREFIX}"]`,
  )) {
    const testId = button.dataset.testid ?? "";
    out.push(
      sampleOf(
        testId.startsWith(CLOUD_ROW_PREFIX)
          ? testId.slice(CLOUD_ROW_PREFIX.length)
          : testId.slice(LOCAL_ROW_PREFIX.length),
        button,
        at,
      ),
    );
  }
  for (const rail of document.querySelectorAll<HTMLElement>(
    "[data-tree-guide-for]",
  )) {
    out.push(sampleOf(`rail:${rail.dataset.treeGuideFor ?? ""}`, rail, at));
  }
  return out;
}
/**
 * Runs `read` in the next frame of Motion's own frame loop, in its last step
 * (`postRender`): after every transform and opacity Motion writes in that
 * frame, so what `read` sees is that frame's drawing, rows and styles alike.
 * A plain animation frame callback can run before Motion's in the same frame
 * and read the frame before.
 */
function inNextMotionFrame<T>(read: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    frame.postRender(() => {
      resolve(read());
    });
  });
}
/**
 * How long a recording runs after the change, whatever the frame rate: a fade
 * then a slide, 160 ms each, with margin.
 */
const RECORD_WINDOW_MS = 5 * 160;
/** The index of the commit counted for the last change, when counting. */
let changeCommit: number | null = null;
/** When the last recorded change ran, as `performance.now()`. */
let changeStartedAt = 0;
/**
 * Samples, runs `change`, then samples once per Motion frame until it has
 * taken at least `frames` frames and `RECORD_WINDOW_MS` has passed since the
 * change.
 */
async function record(
  change: () => void,
  frames: number,
): Promise<RowSample[][]> {
  const samples: RowSample[][] = [sampleRows(0)];
  const log: unknown = Reflect.get(window, "__chatTreeCommits");
  changeCommit = isCommitLog(log) && log.on ? log.commits.length : null;
  const start = performance.now();
  changeStartedAt = start;
  change();
  while (
    samples.length <= frames ||
    performance.now() - start < RECORD_WINDOW_MS
  ) {
    samples.push(
      await inNextMotionFrame(() =>
        sampleRows(Math.round((performance.now() - start) * 10) / 10),
      ),
    );
  }
  return samples;
}
function scroller(): HTMLElement {
  const region = document.querySelector<HTMLElement>(
    '[data-testid="epic-chat-tree-region"]',
  );
  for (let el = region; el !== null; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  throw new Error("no scroll container above the tree region");
}
/** A cloud chat of the task: `parentId` makes it a subagent of that cloud chat. */
interface CloudSpec {
  readonly id: string;
  readonly parentId: string | null;
}
let cloudChats: readonly CloudSpec[] = [];
function cloudSummary(spec: CloudSpec): CloudChatSummary {
  return {
    identity: { taskId: EPIC_ID, chatId: spec.id, ownerUserId: USER_ID },
    ownerHostId: "host-cloud",
    createdAt: 100,
    visibility: "task",
    title: `Cloud ${spec.id}`,
    isTitleEditedByUser: false,
    parentChatId: spec.parentId,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 300,
    headSha256: null,
    publishedAt: 300,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}
function listedCloudChats(): { readonly chats: CloudChatSummary[] } {
  return { chats: cloudChats.map(cloudSummary) };
}
/**
 * Makes `specs` the task's cloud chats and has the list fetch them again; the
 * rows follow once the answer lands.
 */
function seedCloudChats(specs: readonly CloudSpec[]): void {
  cloudChats = specs;
  void queryClient.invalidateQueries();
}
/**
 * Makes `specs` the task's cloud chats in the list's cached answer at once,
 * so the rows follow in the render this call causes and not after a fetch.
 * Returns how many cached lists it wrote: one when the list is mounted.
 */
function replaceCloudChats(specs: readonly CloudSpec[]): number {
  cloudChats = specs;
  const written = queryClient.getQueryCache().findAll({
    predicate: (query) => {
      const data: unknown = query.state.data;
      return typeof data === "object" && data !== null && "chats" in data;
    },
  });
  for (const query of written) {
    queryClient.setQueryData(query.queryKey, listedCloudChats());
  }
  return written.length;
}
function clickChevron(id: string): void {
  const glyph = document.querySelector(
    `[data-testid="epic-sidebar-item-${id}"] svg`,
  );
  if (glyph === null) throw new Error(`no chevron on row ${id}`);
  glyph.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}
const errors = captureFixtureErrors();
/** What one React commit rendered; see the counting hook in the html. */
interface CommitCount {
  readonly rows: number;
  readonly mounted: number;
  readonly panel: number;
  /** When it committed: `performance.now()` in the log, ms after the change once read. */
  readonly at: number;
}
interface CommitLog {
  on: boolean;
  row: string;
  panel: string;
  commits: CommitCount[];
}
function isCommitLog(value: unknown): value is CommitLog {
  return typeof value === "object" && value !== null && "commits" in value;
}
function commitLog(): CommitLog {
  const log: unknown = Reflect.get(window, "__chatTreeCommits");
  if (!isCommitLog(log))
    throw new Error("the page's commit counter is missing");
  return log;
}
const probe = {
  ready: false,
  errors,
  scrollTo: (top: number) => {
    scroller().scrollTop = top;
  },
  scrollTop: () => scroller().scrollTop,
  /** The scroller's box: the rows that are in view lie between these. */
  viewport: () => {
    const box = scroller().getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  },
  /** Counts each commit's renders of the `row` and `panel` components from now on. */
  startCommitCount: (row: string, panel: string) => {
    const log = commitLog();
    log.commits.length = 0;
    log.row = row;
    log.panel = panel;
    log.on = true;
  },
  /**
   * The commits counted from the last recorded change's on, the first being
   * that change's; counting off.
   */
  stopCommitCount: (): CommitCount[] => {
    const log = commitLog();
    log.on = false;
    if (changeCommit === null) throw new Error("no change was recorded");
    return log.commits.slice(changeCommit).map((commit) => ({
      ...commit,
      at: Math.round((commit.at - changeStartedAt) * 10) / 10,
    }));
  },
  seedCloudChats,
  recordCloud: (specs: readonly CloudSpec[], frames: number) =>
    record(() => {
      replaceCloudChats(specs);
    }, frames),
  replaceCloudChats,
  setShape: (shape: Shape) => {
    setShape(shape, []);
  },
  recordShape: (shape: Shape, frames: number) =>
    record(() => {
      setShape(shape, []);
    }, frames),
  recordHide: (shape: Shape, kept: readonly string[], frames: number) =>
    record(() => {
      setShape(shape, kept);
    }, frames),
  recordScroll: (top: number, frames: number) =>
    record(() => {
      scroller().scrollTop = top;
    }, frames),
  recordChevron: (id: string, frames: number) =>
    record(() => {
      clickChevron(id);
    }, frames),
  clickChevron,
};
Reflect.set(window, "__chatTreeMotion", probe);
const queryClient = createAppQueryClient();
const HOST_CLIENT = createFixtureSessionHostClient({
  queryClient,
  requestId: () => "chat-tree-motion",
  bearerToken: "tok-1",
  handlers: {
    "epic.listCloudChats": () => Promise.resolve(listedCloudChats()),
    ...ROW_QUERY_HANDLERS,
  },
});
const runnerHost = createFixtureRunnerHost();
const messengerFactory = createFixtureMessengerFactory({
  requestIdPrefix: "chat-tree-motion",
  extra: {},
});

export function Fixture(): ReactNode {
  useEffect(() => {
    probe.ready = true;
  }, []);
  return (
    <div className="flex h-[480px] bg-canvas text-canvas-foreground">
      <div
        data-fixture-panel
        className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-background"
      >
        <ChatTreePanelBody
          epicId={EPIC_ID}
          tabId={TAB_ID}
          messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
        />
      </div>
    </div>
  );
}
export function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <FixtureProviders
      queryClient={queryClient}
      runnerHost={runnerHost}
      messengerFactory={messengerFactory}
    >
      <SidebarProvider>
        <EpicSessionContext value={SESSION}>
          <EpicSessionHostClientContext value={HOST_CLIENT}>
            {props.children}
          </EpicSessionHostClientContext>
        </EpicSessionContext>
      </SidebarProvider>
    </FixtureProviders>
  );
}

mountFixturePage(() => (
  <Providers>
    <Fixture />
  </Providers>
));
