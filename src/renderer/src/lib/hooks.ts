import { useEffect, useState } from 'react'
import type { FolderNode } from '@shared/ipc'
import { engineApi } from './api'
import { useEngine } from '@/store/engine'

export function flattenFolders(node: FolderNode, out: { path: string; count: number; depth: number }[] = [], depth = 0) {
  if (node.path) out.push({ path: node.path, count: node.count, depth })
  for (const c of node.children) flattenFolders(c, out, node.path ? depth + 1 : depth)
  return out
}

/** Library folder tree, refreshed on library events. */
export function useLibraryTree(): FolderNode | null {
  const version = useEngine((s) => s.libraryVersion)
  const ready = useEngine((s) => s.phase === 'ready')
  const [tree, setTree] = useState<FolderNode | null>(null)
  useEffect(() => {
    if (!ready) return
    engineApi.tree().then(setTree).catch(() => undefined)
  }, [version, ready])
  return tree
}
