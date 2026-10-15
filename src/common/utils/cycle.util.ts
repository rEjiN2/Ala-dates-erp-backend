export async function wouldCreateCycle(
  nodeId: string,
  newParentId: string,
  getParentId: (id: string) => Promise<string | null>,
): Promise<boolean> {
  if (newParentId === nodeId) {
    return true;
  }

  const visited = new Set<string>([nodeId]);
  let currentId: string | null = newParentId;

  while (currentId) {
    if (visited.has(currentId)) {
      return true;
    }
    visited.add(currentId);
    currentId = await getParentId(currentId);
  }

  return false;
}
