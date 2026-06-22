import type { TreeNodeData, TreeNodeNested } from "@/lib/tree-types";

export interface FlatTreeRecordAdapter<TRecord, TData extends TreeNodeData> {
  getId: (record: TRecord) => string;
  getParentId: (record: TRecord) => string | null | undefined;
  getData: (record: TRecord) => TData;
  isGroup?: (record: TRecord, children: readonly TRecord[]) => boolean;
}

/**
 * Convert flat records into the nested node format consumed by the tree.
 * This is the main ingestion seam for API-backed data.
 */
export function buildTreeFromFlatRecords<TRecord, TData extends TreeNodeData>(
  records: readonly TRecord[],
  adapter: FlatTreeRecordAdapter<TRecord, TData>,
): TreeNodeNested<TData>[] {
  const knownIds = new Set(records.map(adapter.getId));
  const childrenOf = new Map<string, TRecord[]>();
  const roots: TRecord[] = [];

  for (const record of records) {
    const parentId = adapter.getParentId(record);
    if (
      parentId === null ||
      parentId === undefined ||
      !knownIds.has(parentId)
    ) {
      roots.push(record);
      continue;
    }

    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(record);
    childrenOf.set(parentId, siblings);
  }

  function toNested(record: TRecord): TreeNodeNested<TData> {
    const id = adapter.getId(record);
    const children = childrenOf.get(id) ?? [];
    const nestedChildren =
      children.length === 0 ? undefined : children.map(toNested);

    return {
      id,
      data: adapter.getData(record),
      isGroup: adapter.isGroup?.(record, children),
      children: nestedChildren,
    };
  }

  return roots.map(toNested);
}
