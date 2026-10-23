import type { GitStatusEntry } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useEffect, useRef, type FC } from 'react';
import { categoryLabels } from '../../shared/classify.ts';
import type { Category, ReviewFile } from '../../shared/review.ts';

const shortLabels = {
  source: '',
  migration: 'sql',
  contract: 'api',
  generated: 'gen',
  lockfile: 'lock'
} satisfies Record<Category, string>;

const treeStatuses = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'added',
  changed: 'modified',
  unchanged: 'modified'
} satisfies Record<ReviewFile['status'], GitStatusEntry['status']>;

interface ChangeTreeProps {
  files: readonly ReviewFile[];
  onOpen(path: string): void;
}

/** The changed files as a tree, generated ones dimmed; choosing one scrolls the diffs to it. */
export const ChangeTree: FC<ChangeTreeProps> = ({ files, onOpen }) => {
  const categoryOf = useRef(new Map<string, Category>());
  const { model } = useFileTree({
    paths: files.map(file => file.path),
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    density: 'compact',
    search: true,
    onSelectionChange: paths => {
      const path = paths.at(-1);
      if (path && categoryOf.current.has(path)) onOpen(path);
    },
    renderRowDecoration: ({ item }) => {
      const category = categoryOf.current.get(item.path);
      return category && category !== 'source'
        ? { text: shortLabels[category], title: categoryLabels[category] }
        : null;
    }
  });

  useEffect(() => {
    categoryOf.current = new Map(files.map(file => [file.path, file.category]));
    model.resetPaths(files.map(file => file.path));
    model.setGitStatus(
      files.map(file => ({
        path: file.path,
        // Generated files show as ignored: dimmed, as they are not what to read.
        status: file.category === 'generated' || file.category === 'lockfile' ? 'ignored' : treeStatuses[file.status]
      }))
    );
  }, [files, model]);

  return <FileTree model={model} className="tree" />;
};
