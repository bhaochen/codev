export const SNAPSHOT_TOOL_NAME = 'Snapshot'

export const DESCRIPTION =
  'Save, list, diff, compare, or restore working-tree snapshots in an isolated shadow Git repository.'

export const SNAPSHOT_TOOL_PROMPT = `Manage persistent working-tree snapshots stored separately from the project's Git repository.

- save: capture non-ignored files up to 2 MB each; optionally add a short label.
- list: show recent snapshots with hashes, dates, and labels.
- diff: compare a snapshot to the current working tree, or compare hash (base) to compareHash (target).
- restore: overwrite files present in the selected snapshot. Files absent from that snapshot are left untouched. Confirm before restoring unless the user explicitly requested it.

Snapshots do not change the project's Git branch, refs, or index. Save before risky work; inspect a diff before restoring.`
