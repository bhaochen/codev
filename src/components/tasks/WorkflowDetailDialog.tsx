import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  // DeepImmutable<...> upstream; readonly shapes assign into this fine.
  workflow: LocalWorkflowTaskState
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
}

function StatusGlyph({ status }: { status: LocalWorkflowTaskState['status'] }): React.ReactNode {
  switch (status) {
    case 'running':
      return <Text color="warning">◐ running</Text>
    case 'completed':
      return <Text color="success">✓ completed</Text>
    case 'failed':
      return <Text color="error">✗ failed</Text>
    case 'killed':
      return <Text color="error">⊘ killed</Text>
    default:
      return <Text>· {status}</Text>
  }
}

export function WorkflowDetailDialog(props: Props): React.ReactNode {
  const { workflow, onDone, onBack } = props
  useKeybindings(
    {
      'confirm:yes': onDone,
      ...(onBack ? { 'app:left': onBack } : {}),
    },
    { context: 'WorkflowDetail' },
  )

  // Inline steps have no separable sub-agents; skip/retry affordances are
  // surfaced as unsupported by the task module. Kill is handled by the list.
  void props.onKill
  void props.onSkipAgent
  void props.onRetryAgent

  return (
    <Dialog
      title={`Workflow ${workflow.workflowName}`}
      subtitle={<StatusGlyph status={workflow.status} />}
      onCancel={onDone}
    >
      <Box flexDirection="column">
        <Text>run:     {workflow.runId}</Text>
        <Text dimColor>{workflow.description}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Steps execute inline in this conversation. Manage with:</Text>
          <Text>
            /workflows status · /workflows pause · /workflows resume · /workflows cancel
          </Text>
          <Text dimColor>Checkpoint answers: /workflows answer {'<json>'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>
            <KeyboardShortcutHint keybinding="confirm:yes" action="close" />
            {onBack ? (
              <>
                {' '}
                <KeyboardShortcutHint keybinding="←" action="back" />
              </>
            ) : null}
          </Text>
        </Box>
        <Byline />
      </Box>
    </Dialog>
  )
}
