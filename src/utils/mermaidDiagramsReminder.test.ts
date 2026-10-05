import { describe, expect, test } from 'bun:test'
import {
  getAnnouncedMermaidDiagrams,
  getMermaidDiagramsChange,
  getMermaidDiagramsReminder,
  getMermaidNotDrawnReminder,
} from './mermaidDiagramsReminder.js'

const announced = (enabled: boolean) => ({
  type: 'attachment',
  attachment: { type: 'mermaid_diagrams', enabled },
})

describe('getMermaidDiagramsChange', () => {
  test('announces only a state change', () => {
    expect(getMermaidDiagramsChange(true, [])).toBe(true)
    expect(getMermaidDiagramsChange(false, [])).toBeNull()
    expect(getMermaidDiagramsChange(false, [announced(true)])).toBe(false)
    expect(getMermaidDiagramsChange(false, [announced(false)])).toBeNull()
  })

  test('uses the most recent announcement and re-announces after compaction', () => {
    expect(
      getAnnouncedMermaidDiagrams([announced(true), announced(false)]),
    ).toBe(false)
    expect(getMermaidDiagramsChange(true, [{ type: 'system' }])).toBe(true)
  })
})

describe('diagram reminders', () => {
  test('encourages small terminal-ready diagrams across providers', () => {
    const reminder = getMermaidDiagramsReminder(true)
    expect(reminder).toContain('Codev draws ```mermaid')
    expect(reminder).toContain('flowchart TD')
    expect(reminder).toContain('short plain-language description')
    expect(reminder).toContain('Python kernel and Matplotlib')
  })

  test('asks the model not to draw diagrams when disabled', () => {
    expect(getMermaidDiagramsReminder(false)).toContain(
      'Only write Mermaid when the user asks',
    )
  })

  test('explains when the terminal could not draw a diagram', () => {
    const reminder = getMermaidNotDrawnReminder([
      'it needs 80 columns and the terminal has 40',
    ])
    expect(reminder).toContain('80 columns')
    expect(reminder).toContain('keep labels short')
  })
})
