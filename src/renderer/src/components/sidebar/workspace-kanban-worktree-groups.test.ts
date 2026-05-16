import { describe, expect, it } from 'vitest'
import { clusterByWorkspaceGroup } from './workspace-kanban-worktree-groups'
import type { Worktree } from '../../../../shared/types'

const wt = (id: string, groupId: string | null = null, isPinned = false): Worktree =>
  ({ id, workspaceGroupId: groupId, isPinned }) as Worktree

describe('clusterByWorkspaceGroup', () => {
  it('no-ops on 0 or 1 item', () => {
    const empty: Worktree[] = []
    clusterByWorkspaceGroup(empty)
    expect(empty).toEqual([])
    const one = [wt('a', 'g1')]
    clusterByWorkspaceGroup(one)
    expect(one.map((w) => w.id)).toEqual(['a'])
  })

  it('keeps order when no groups present', () => {
    const items = [wt('a'), wt('b'), wt('c')]
    clusterByWorkspaceGroup(items)
    expect(items.map((w) => w.id)).toEqual(['a', 'b', 'c'])
  })

  it('clusters members of same group adjacent to first occurrence', () => {
    const items = [wt('a', 'g1'), wt('b'), wt('c', 'g1'), wt('d')]
    clusterByWorkspaceGroup(items)
    expect(items.map((w) => w.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('handles multiple groups', () => {
    const items = [wt('a', 'g1'), wt('b', 'g2'), wt('c', 'g1'), wt('d', 'g2'), wt('e')]
    clusterByWorkspaceGroup(items)
    expect(items.map((w) => w.id)).toEqual(['a', 'c', 'b', 'd', 'e'])
  })

  it('skips pinned items', () => {
    const items = [wt('a', 'g1', true), wt('b'), wt('c', 'g1')]
    clusterByWorkspaceGroup(items)
    expect(items.map((w) => w.id)).toEqual(['a', 'b', 'c'])
  })

  it('mutates input in place', () => {
    const items = [wt('a', 'g1'), wt('b'), wt('c', 'g1')]
    const ref = items
    clusterByWorkspaceGroup(items)
    expect(items).toBe(ref)
  })
})
