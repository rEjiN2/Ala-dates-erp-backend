import { describe, expect, it } from 'vitest';
import { buildTree, type TreeItem } from './tree.util.js';

interface Node extends TreeItem {
  name: string;
}

describe('buildTree', () => {
  it('handles mixed depth: nested groups alongside flat top-level groups', () => {
    // Dates
    //   Ajwa
    //   Ambar
    //   Sukari
    // Packaging Materials   (flat, no children)
    // Gift & Bundle Items   (flat, no children)
    const items: Node[] = [
      { id: 'dates', name: 'Dates', parentId: null },
      { id: 'ajwa', name: 'Ajwa', parentId: 'dates' },
      { id: 'ambar', name: 'Ambar', parentId: 'dates' },
      { id: 'sukari', name: 'Sukari', parentId: 'dates' },
      { id: 'packaging', name: 'Packaging Materials', parentId: null },
      { id: 'gift', name: 'Gift & Bundle Items', parentId: null },
    ];

    const tree = buildTree(items);

    expect(tree).toHaveLength(3);

    const dates = tree.find((node) => node.id === 'dates');
    expect(dates?.children.map((child) => child.name).sort()).toEqual(['Ajwa', 'Ambar', 'Sukari']);
    expect(dates?.children.every((child) => child.children.length === 0)).toBe(true);

    const packaging = tree.find((node) => node.id === 'packaging');
    expect(packaging?.children).toEqual([]);

    const gift = tree.find((node) => node.id === 'gift');
    expect(gift?.children).toEqual([]);
  });

  it('returns just the requested subtree when rootId is given', () => {
    const items: Node[] = [
      { id: 'dates', name: 'Dates', parentId: null },
      { id: 'ajwa', name: 'Ajwa', parentId: 'dates' },
      { id: 'packaging', name: 'Packaging Materials', parentId: null },
    ];

    const tree = buildTree(items, 'dates');

    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('dates');
    expect(tree[0].children.map((child) => child.id)).toEqual(['ajwa']);
  });

  it('returns an empty forest for an unknown rootId', () => {
    const items: Node[] = [{ id: 'dates', name: 'Dates', parentId: null }];
    expect(buildTree(items, 'does-not-exist')).toEqual([]);
  });

  it('returns an empty forest for an empty collection', () => {
    expect(buildTree([])).toEqual([]);
  });
});
