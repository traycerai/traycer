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

/** One command's edit, drawn over the view until the view has caught up. */
interface Layer {
  readonly id: number;
  readonly patch: AppearancePatch;
  /**
   * Set once the host acknowledged the command that carried this layer:
   * its id, and the row version the view held when it was sent (`null` for
   * no row). `null` while the command is queued or out.
   */
  readonly acknowledged: {
    readonly commandId: string;
    readonly baseVersion: string | null;
  } | null;
}

type Layers = ReadonlyMap<string, readonly Layer[]>;

/** One task's sends: the command that is out, and the edits merged behind it. */
interface AppearanceSends {
  sending: Promise<unknown>;
  queued: {
    readonly layerId: number;
    readonly patch: AppearancePatch;
    readonly sent: Promise<void>;
  } | null;
}

const NO_LAYERS: Layers = new Map();

function patchOf(action: AppearanceAction): AppearancePatch {
  const patch: AppearancePatch = {};
  if (action.color !== undefined) patch.color = action.color;
  if (action.icon !== undefined) patch.icon = action.icon;
  return patch;
}

function rowOf(
  view: OrganizationView | undefined,
  taskId: string,
): OrganizationView["appearances"][number] | undefined {
  return view?.appearances.find((row) => row.taskId === taskId);
}

/**
 * Whether the view has caught up with an acknowledged layer, so that drawing
 * it is the view's job from now on: the view names its command as pending or
 * failed, shows the edit, or has moved the row on from the version it was
 * sent against. The host's own projection then draws a queued edit, a
 * delivered one, a refusal rolled back, or a later change made elsewhere.
 */
function caughtUp(
  taskId: string,
  layer: Layer,
  view: OrganizationView | undefined,
): boolean {
  const acknowledged = layer.acknowledged;
  if (acknowledged === null || view === undefined) return false;
  if (
    [...view.pending, ...view.failures].some((item) =>
      item.commandIds.includes(acknowledged.commandId),
    )
  )
    return true;
  const row = rowOf(view, taskId);
  if ((row?.version ?? null) !== acknowledged.baseVersion) return true;
  return (
    row !== undefined &&
    (layer.patch.color === undefined || layer.patch.color === row.color) &&
    (layer.patch.icon === undefined || layer.patch.icon === row.icon)
  );
}

function withLayer(
  current: Layers,
  taskId: string,
  update: (layers: readonly Layer[]) => readonly Layer[],
): Layers {
  const before = current.get(taskId) ?? [];
  const after = update(before);
  if (after === before) return current;
  const next = new Map(current);
  if (after.length === 0) next.delete(taskId);
  else next.set(taskId, after);
  return next;
}

function withoutCaughtUp(
  current: Layers,
  view: OrganizationView | undefined,
): Layers {
  let next = current;
  for (const [taskId, layers] of current) {
    const kept = layers.filter((layer) => !caughtUp(taskId, layer, view));
    if (kept.length !== layers.length)
      next = withLayer(next, taskId, () => kept);
  }
  return next;
}

function withPendingAppearances(
  view: OrganizationView,
  layers: Layers,
): OrganizationView {
  const drawn = (taskId: string): AppearancePatch | null => {
    const patches = (layers.get(taskId) ?? [])
      .filter((layer) => !caughtUp(taskId, layer, view))
      .map((layer) => layer.patch);
    if (patches.length === 0) return null;
    const merged: AppearancePatch = {};
    for (const patch of patches) Object.assign(merged, patch);
    return merged;
  };
  if (!view.appearances.some((row) => drawn(row.taskId) !== null)) return view;
  return {
    ...view,
    appearances: view.appearances.map((row) => ({
      ...row,
      ...drawn(row.taskId),
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
 * carries the latest value of each field. Each command's edit is its own
 * layer, so a refusal rolls back that command's fields and nothing else.
 *
 * `send` resolves with the id of the command it sent. A host or account
 * change discards every layer; a command from before it settles nothing.
 */
export function useAppearanceEdits(args: {
  readonly scope: string;
  readonly view: OrganizationView | undefined;
  readonly send: (action: OrganizationAction) => Promise<string>;
}): {
  readonly view: OrganizationView | undefined;
  readonly edit: (action: AppearanceAction) => Promise<void>;
} {
  const { scope, view, send } = args;
  const [layers, setLayers] = useState<Layers>(NO_LAYERS);
  const nextLayerId = useRef(0);
  const sends = useRef(new Map<string, AppearanceSends>());
  useEffect(() => {
    sends.current = new Map();
  }, [scope]);
  const latestView = useRef(view);
  useLayoutEffect(() => {
    latestView.current = view;
  }, [view]);
  // Once the view has caught up with a layer it stays the view's: a later
  // frame that rolls the row back to the version it was sent against must
  // not bring the layer back.
  const [checked, setChecked] = useState({ scope, view });
  if (checked.scope !== scope || checked.view !== view) {
    setChecked({ scope, view });
    setLayers((current) =>
      checked.scope === scope ? withoutCaughtUp(current, view) : NO_LAYERS,
    );
  }

  const edit = useCallback(
    (action: AppearanceAction): Promise<void> => {
      const { taskId } = action;
      const patch = patchOf(action);
      const tasks = sends.current;
      const slot = tasks.get(taskId);
      const queued = slot?.queued ?? null;
      if (queued !== null) {
        Object.assign(queued.patch, patch);
        const merged = { ...queued.patch };
        setLayers((current) =>
          withLayer(current, taskId, (taskLayers) =>
            taskLayers.map((layer) =>
              layer.id === queued.layerId ? { ...layer, patch: merged } : layer,
            ),
          ),
        );
        return queued.sent;
      }

      const layerId = nextLayerId.current++;
      setLayers((current) =>
        withLayer(current, taskId, (taskLayers) => [
          ...taskLayers,
          { id: layerId, patch, acknowledged: null },
        ]),
      );
      const settle = (
        acknowledged: { commandId: string; baseVersion: string | null } | null,
      ): void =>
        setLayers((current) =>
          withLayer(current, taskId, (taskLayers) => {
            if (!taskLayers.some((layer) => layer.id === layerId))
              return taskLayers;
            return taskLayers.flatMap((layer) => {
              if (layer.id !== layerId) return [layer];
              if (acknowledged === null) return [];
              const settled = { ...layer, acknowledged };
              return caughtUp(taskId, settled, latestView.current)
                ? []
                : [settled];
            });
          }),
        );
      const start = (
        owner: AppearanceSends,
        next: AppearancePatch,
      ): Promise<void> => {
        const baseVersion = rowOf(latestView.current, taskId)?.version ?? null;
        const sent = send({ kind: "appearance", taskId, ...next });
        owner.sending = sent;
        const release = (): void => {
          if (
            owner.sending === sent &&
            owner.queued === null &&
            tasks.get(taskId) === owner
          )
            tasks.delete(taskId);
        };
        sent.then(
          (commandId) => {
            release();
            settle({ commandId, baseVersion });
          },
          () => {
            release();
            settle(null);
          },
        );
        return sent.then(() => undefined);
      };

      if (slot === undefined) {
        const opened: AppearanceSends = {
          sending: Promise.resolve(),
          queued: null,
        };
        tasks.set(taskId, opened);
        return start(opened, patch);
      }
      const merged = { ...patch };
      const done = (): void => undefined;
      const sent = slot.sending.then(done, done).then(() => {
        slot.queued = null;
        return start(slot, merged);
      });
      slot.queued = { layerId, patch: merged, sent };
      return sent;
    },
    [send],
  );

  const drawn = useMemo(
    () =>
      view === undefined ? undefined : withPendingAppearances(view, layers),
    [view, layers],
  );
  return { view: drawn, edit };
}
