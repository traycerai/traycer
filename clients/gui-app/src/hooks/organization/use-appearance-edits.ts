import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";

type AppearanceAction = Extract<OrganizationAction, { kind: "appearance" }>;

interface AppearancePatch {
  color?: string | null;
  icon?: string | null;
}

interface PendingAppearance {
  readonly patch: AppearancePatch;
  /**
   * The row version the view held when the last send for this task was
   * acknowledged, `null` for no row, and `undefined` while a send is out.
   * The patch is drawn until the view's row moves past that version: the
   * snapshot carrying the edit, or a later change made elsewhere.
   */
  readonly settledVersion: string | null | undefined;
}

interface PendingAppearances {
  readonly scope: string;
  readonly rows: ReadonlyMap<string, PendingAppearance>;
}

/** One task's sends: the command that is out, and the edits merged behind it. */
interface AppearanceSends {
  sending: Promise<void>;
  queued: {
    readonly patch: AppearancePatch;
    readonly sent: Promise<void>;
  } | null;
}

const NO_ROWS: ReadonlyMap<string, PendingAppearance> = new Map();

function patchOf(action: AppearanceAction): AppearancePatch {
  const patch: AppearancePatch = {};
  if (action.color !== undefined) patch.color = action.color;
  if (action.icon !== undefined) patch.icon = action.icon;
  return patch;
}

function rowVersion(
  view: OrganizationView | undefined,
  taskId: string,
): string | null {
  return (
    view?.appearances.find((row) => row.taskId === taskId)?.version ?? null
  );
}

function superseded(entry: PendingAppearance, version: string | null): boolean {
  return entry.settledVersion !== undefined && entry.settledVersion !== version;
}

function withPendingAppearances(
  view: OrganizationView,
  rows: ReadonlyMap<string, PendingAppearance>,
): OrganizationView {
  const drawn = (taskId: string, version: string): PendingAppearance | null => {
    const entry = rows.get(taskId);
    return entry === undefined || superseded(entry, version) ? null : entry;
  };
  if (!view.appearances.some((row) => drawn(row.taskId, row.version)))
    return view;
  return {
    ...view,
    appearances: view.appearances.map((row) => ({
      ...row,
      ...drawn(row.taskId, row.version)?.patch,
    })),
  };
}

/**
 * Appearance edits, drawn before the serving host answers and sent one at a
 * time per task.
 *
 * The host compares each edit against the row version it reads, so two edits
 * to one task that are out together cannot both land: the second is refused
 * as a conflict. An edit made while another is out therefore waits for it,
 * and edits that pile up behind the same send merge into one command that
 * carries the latest value of each field.
 */
export function useAppearanceEdits(args: {
  readonly scope: string;
  readonly view: OrganizationView | undefined;
  readonly send: (action: OrganizationAction) => Promise<void>;
}): {
  readonly view: OrganizationView | undefined;
  readonly edit: (action: AppearanceAction) => Promise<void>;
} {
  const { scope, view, send } = args;
  const [pending, setPending] = useState<PendingAppearances>({
    scope,
    rows: NO_ROWS,
  });
  const sends = useRef(new Map<string, AppearanceSends>());
  useEffect(() => {
    sends.current = new Map();
  }, [scope]);
  const latestView = useRef(view);
  useLayoutEffect(() => {
    latestView.current = view;
  }, [view]);

  const edit = useCallback(
    (action: AppearanceAction): Promise<void> => {
      const { taskId } = action;
      const patch = patchOf(action);
      setPending((current) => {
        const rows = new Map(current.scope === scope ? current.rows : NO_ROWS);
        const prior = rows.get(taskId);
        const carried =
          prior !== undefined &&
          !superseded(prior, rowVersion(latestView.current, taskId))
            ? prior.patch
            : {};
        rows.set(taskId, {
          patch: { ...carried, ...patch },
          settledVersion: undefined,
        });
        return { scope, rows };
      });

      const tasks = sends.current;
      const start = (slot: AppearanceSends, next: AppearancePatch) => {
        const sent = send({ kind: "appearance", taskId, ...next });
        slot.sending = sent;
        const finish = (refused: boolean): void => {
          if (slot.sending !== sent || slot.queued !== null) return;
          if (tasks.get(taskId) === slot) tasks.delete(taskId);
          setPending((current) => {
            const entry = current.rows.get(taskId);
            if (current.scope !== scope || entry === undefined) return current;
            const rows = new Map(current.rows);
            if (refused) rows.delete(taskId);
            else
              rows.set(taskId, {
                patch: entry.patch,
                settledVersion: rowVersion(latestView.current, taskId),
              });
            return { scope, rows };
          });
        };
        sent.then(
          () => finish(false),
          () => finish(true),
        );
        return sent;
      };

      const slot = tasks.get(taskId);
      if (slot === undefined) {
        const opened: AppearanceSends = {
          sending: Promise.resolve(),
          queued: null,
        };
        tasks.set(taskId, opened);
        return start(opened, patch);
      }
      if (slot.queued !== null) {
        Object.assign(slot.queued.patch, patch);
        return slot.queued.sent;
      }
      const merged = { ...patch };
      const settled = (): void => undefined;
      const sent = slot.sending.then(settled, settled).then(() => {
        slot.queued = null;
        return start(slot, merged);
      });
      slot.queued = { patch: merged, sent };
      return sent;
    },
    [scope, send],
  );

  const rows = pending.scope === scope ? pending.rows : NO_ROWS;
  const drawn = useMemo(
    () => (view === undefined ? undefined : withPendingAppearances(view, rows)),
    [view, rows],
  );
  return { view: drawn, edit };
}
