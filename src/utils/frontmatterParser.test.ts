import { describe, expect, test } from 'bun:test'
import { parseFrontmatter } from './frontmatterParser.js'

describe('parseFrontmatter', () => {
  test('parses frontmatter and returns the body', () => {
    const r = parseFrontmatter('---\ntitle: Hi\n---\nbody text')
    expect(r.frontmatter.title).toBe('Hi')
    expect(r.content).toBe('body text')
  })

  test('a --- inside a value does not end the frontmatter', () => {
    const r = parseFrontmatter(
      '---\ndescription: a --- b\npaths:\n  - src\n---\nbody',
    )
    expect(r.frontmatter.description).toBe('a --- b')
    expect(r.frontmatter.paths).toEqual(['src'])
    expect(r.content).toBe('body')
  })

  test('handles CRLF line endings', () => {
    const r = parseFrontmatter('---\r\ntitle: Hi\r\n---\r\nbody')
    expect(r.frontmatter.title).toBe('Hi')
    expect(r.content).toBe('body')
  })

  test('strips a leading BOM so frontmatter is still detected', () => {
    const r = parseFrontmatter('\uFEFF---\ntitle: Hi\n---\nbody')
    expect(r.frontmatter.title).toBe('Hi')
    expect(r.content).toBe('body')
  })

  test('no frontmatter returns the content unchanged (BOM removed)', () => {
    expect(parseFrontmatter('just text')).toEqual({
      frontmatter: {},
      content: 'just text',
    })
    expect(parseFrontmatter('\uFEFFplain').content).toBe('plain')
  })
})
