import { describe, expect, test } from 'bun:test'
import { findNotebookCellIndex, parseCellId } from './notebook.js'

describe('parseCellId', () => {
  test('accepts cell-N and bare N', () => {
    expect(parseCellId('cell-3')).toBe(3)
    expect(parseCellId('3')).toBe(3)
    expect(parseCellId('cell-0')).toBe(0)
  })

  test('rejects anything else', () => {
    expect(parseCellId('cell-x')).toBeUndefined()
    expect(parseCellId('x')).toBeUndefined()
    expect(parseCellId('cell--1')).toBeUndefined()
    expect(parseCellId('cell-1a')).toBeUndefined()
  })
})

describe('findNotebookCellIndex', () => {
  test('matches a stored id first', () => {
    const cells = [{ id: 'abc' }, { id: 'def' }]
    expect(findNotebookCellIndex(cells, 'def')).toBe(1)
    expect(findNotebookCellIndex(cells, 'abc')).toBe(0)
  })

  test('a position names an id-less cell', () => {
    const cells = [{ id: null }, { id: 'x' }]
    expect(findNotebookCellIndex(cells, 'cell-0')).toBe(0)
    expect(findNotebookCellIndex(cells, '0')).toBe(0)
  })

  test('a position never names a cell that has a stored id', () => {
    const cells = [{ id: 'x' }, { id: null }]
    // position 0 holds an id-bearing cell → stale, refuse
    expect(findNotebookCellIndex(cells, 'cell-0')).toBe(-1)
    expect(findNotebookCellIndex(cells, '0')).toBe(-1)
  })

  test('out-of-range positions and unknown ids return -1', () => {
    const cells = [{ id: null }]
    expect(findNotebookCellIndex(cells, 'cell-5')).toBe(-1)
    expect(findNotebookCellIndex(cells, 'nope')).toBe(-1)
  })
})
