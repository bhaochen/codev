import type { Input } from './WorkflowTool.js'

export function renderToolUseMessage(input: Partial<Input>): string {
  switch (input.action) {
    case 'start':
      return `workflow start ${input.name ?? ''}`
    case 'submit':
      return 'workflow submit'
    case 'answer':
      return 'workflow answer'
    default:
      return `workflow ${input.action ?? ''}`.trim()
  }
}
