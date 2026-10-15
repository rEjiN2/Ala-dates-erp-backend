export interface TreeItem {
  id: string;
  parentId: string | null;
}

export type TreeNode<T extends TreeItem> = T & { children: TreeNode<T>[] };

const ROOT_KEY = 'root';

/**
 * Groups a flat, already-fetched list of self-referencing nodes into a
 * nested forest (or a single subtree when rootId is given). Callers are
 * responsible for confirming rootId actually exists — an unknown rootId
 * just yields an empty forest here.
 */
export function buildTree<T extends TreeItem>(items: readonly T[], rootId?: string): TreeNode<T>[] {
  const byParent = new Map<string, T[]>();
  for (const item of items) {
    const key = item.parentId ?? ROOT_KEY;
    const bucket = byParent.get(key) ?? [];
    bucket.push(item);
    byParent.set(key, bucket);
  }

  const buildNode = (item: T): TreeNode<T> => ({
    ...item,
    children: (byParent.get(item.id) ?? []).map(buildNode),
  });

  if (rootId) {
    const root = items.find((item) => item.id === rootId);
    return root ? [buildNode(root)] : [];
  }

  return (byParent.get(ROOT_KEY) ?? []).map(buildNode);
}
