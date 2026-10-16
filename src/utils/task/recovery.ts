/**
 * Restart recovery for in-flight background shell tasks.
 *
 * A background task that was still running when the process died leaves a
 * row in the background_tasks mirror (services/db/pendingNotificationStore.ts).
 * On the next interactive launch of the same project, each such row is
 * converted into a durable "interrupted" task-notification: the model learns
 * the command never finished, sees the last output, and can re-run it —
 * instead of the task silently vanishing. Modeled after opencode's
 * "Command cancelled because the server restarted" recovery (MIT,
 * packages/core/src/session/execution/restart.ts recoverShell).
 *
 * The notices are statusless (no <status> tag): print.ts treats <status> as
 * a terminal signal and an unknown value would falsely close the task for
 * SDK consumers — same convention as the stall watchdog in LocalShellTask.
 */
import {
  OUTPUT_FILE_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../constants/xml.js'
import {
  loadOrphanedBackgroundTasks,
  untrackBackgroundTask,
} from '../../services/db/pendingNotificationStore.js'
import { deterministicUuid } from '../deterministicUuid.js'
import { tailFile } from '../fsOperations.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { escapeXml } from '../xml.js'

const LOST_TAIL_BYTES = 2000

export async function recoverOrphanedBackgroundTasks(
  projectDir: string,
): Promise<number> {
  const rows = loadOrphanedBackgroundTasks(projectDir)
  let recovered = 0
  for (const row of rows) {
    let tail = ''
    try {
      const result = await tailFile(row.outputPath, LOST_TAIL_BYTES)
      tail = result.content.trimEnd()
    } catch {
      // Output file may be gone (tmp cleanup, short-lived command) — the
      // notice still tells the model the command never finished.
    }
    const summary = `Background command "${row.description}" was still running when the previous process exited`
    const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${row.taskId}</${TASK_ID_TAG}>
<${OUTPUT_FILE_TAG}>${row.outputPath}</${OUTPUT_FILE_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>${tail ? `\nLast output:\n${tail}` : ''}

The process restarted before this command finished, so its state is unknown. Read the output file to see how far it got, then re-run it if needed.`
    enqueuePendingNotification({
      value: message,
      mode: 'task-notification',
      priority: 'later',
      // Durable + idempotent: if the process dies again before delivery,
      // the notice replays exactly once per task.
      uuid: deterministicUuid(`task-notification:${row.taskId}:lost`),
    })
    untrackBackgroundTask(row.taskId)
    recovered++
  }
  return recovered
}
