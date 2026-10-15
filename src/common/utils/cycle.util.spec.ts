import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from './cycle.util.js';

describe('wouldCreateCycle', () => {
  it('detects a node being set as its own parent', async () => {
    const result = await wouldCreateCycle('A', 'A', async () => null);
    expect(result).toBe(true);
  });

  it('detects a multi-level cycle (A -> ... -> B -> A)', async () => {
    // proposed parent chain: B -> C -> A (A is the node being moved)
    const parentOf: Record<string, string | null> = { B: 'C', C: 'A', A: null };
    const result = await wouldCreateCycle('A', 'B', async (id) => parentOf[id] ?? null);
    expect(result).toBe(true);
  });

  it('allows a valid reparent with no cycle', async () => {
    const parentOf: Record<string, string | null> = { B: 'C', C: null };
    const result = await wouldCreateCycle('A', 'B', async (id) => parentOf[id] ?? null);
    expect(result).toBe(false);
  });

  it('does not loop forever on pre-existing corrupt ancestor data', async () => {
    const parentOf: Record<string, string | null> = { X: 'Y', Y: 'X' };
    const result = await wouldCreateCycle('A', 'X', async (id) => parentOf[id] ?? null);
    expect(result).toBe(true);
  });
});
