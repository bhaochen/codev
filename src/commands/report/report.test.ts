/**
 * /report prompt and renderer regressions.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertValidGeneratedReport,
  buildBoundedReportContext,
  buildReportPrompt,
  REPORT_CONTEXT_MAX_CHARS,
  renderHtml,
} from './presentation.js'

const skill = {
  extension: '.html',
  instruction: 'Write source Markdown with a clear hierarchy.',
}

const prompt = buildReportPrompt({
  format: 'html',
  skill,
  context: 'User:\nFix the provider retry boundary.\n\nAssistant:\nThe fix is verified.',
})

describe('buildReportPrompt', () => {
  test('asks for a specific report without a fixed template', () => {
    expect(prompt).toMatch(/specific, informative title/)
    expect(prompt).toMatch(/do not force a template or include empty sections/)
    expect(prompt).toMatch(/session context supplied below/)
    expect(prompt).toMatch(/Fix the provider retry boundary/)
    expect(prompt).not.toMatch(/<session_transcript>/)
    expect(prompt).not.toMatch(/Use these exact sections/)
    expect(prompt).not.toMatch(/# Session Report/)
  })
})

describe('renderHtml', () => {
  test('renders the title and strips unsafe markup', () => {
    const html = renderHtml(`# Retry handling that preserves report output

The report command now retries provider throttling without writing the error as content.

## Result

- Cached request bytes stay stable.
- Provider failures remain failures.

<script>alert('unsafe')</script>`)

    expect(html).toMatch(/<title>Retry handling that preserves report output<\/title>/)
    expect(html).toMatch(/<article>/)
    expect(html).not.toMatch(/<script>/)
  })
})

describe('assertValidGeneratedReport', () => {
  test('rejects provider quota failures instead of writing them as content', () => {
    expect(() =>
      assertValidGeneratedReport(
        'Gemini API error 429: Resource has been exhausted',
      ),
    ).toThrow(/did not return report content/)
    expect(() =>
      assertValidGeneratedReport(
        `API Error: Gemini API error 429: {
  "error": {
    "code": 429,
    "message": "Resource has been exhausted (e.g. check quota).",
    "status": "RESOURCE_EXHAUSTED"
  }
}`,
      ),
    ).toThrow(/did not return report content/)
    expect(() =>
      assertValidGeneratedReport(
        '# This looks superficially like a report',
        { isApiErrorMessage: true },
      ),
    ).toThrow(/did not return report content/)
  })

  test('accepts a real report', () => {
    expect(() =>
      assertValidGeneratedReport(
        '# Provider retry repair\n\nThe failure now reaches the retry controller.',
      ),
    ).not.toThrow()
  })

  test('quota refusals blame the upstream limit, not the command', () => {
    expect(() =>
      assertValidGeneratedReport(
        'API Error: Gemini API error 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}',
      ),
    ).toThrow(/upstream limit/)
    expect(() =>
      assertValidGeneratedReport('API Error: Gemini API error 429: {'),
    ).toThrow(/rate-limit\/quota error/)
  })

  test('a supplied failure hint replaces the quoted provider line', () => {
    expect(() =>
      assertValidGeneratedReport(
        'API Error: Gemini API error 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}',
        { failureHint: 'This Antigravity account is not entitled to gemini-3.8-flash-high.' },
      ),
    ).toThrow(/not entitled to gemini-3\.8-flash-high/)
  })

  test('non-quota failures keep quoting the provider', () => {
    expect(() =>
      assertValidGeneratedReport('API Error: failed to authenticate'),
    ).toThrow(/Provider said: API Error: failed to authenticate/)
  })
})

describe('buildBoundedReportContext', () => {
  test('preserves short sessions byte-for-byte', () => {
    const shortContext = 'User:\nsmall session\n\n---\n\nAssistant:\ndone'
    expect(buildBoundedReportContext([shortContext])).toBe(shortContext)
  })

  test('bounds long sessions while keeping head, middle and tail', () => {
    const veryLongContext = [
      `BEGIN-GOAL ${'a'.repeat(30_000)}`,
      `${'b'.repeat(15_000)} MIDDLE-DECISION ${'b'.repeat(15_000)}`,
      `LATEST-OUTCOME ${'c'.repeat(30_000)} END-OUTCOME`,
    ]
    const boundedContext = buildBoundedReportContext(veryLongContext)
    expect(boundedContext.length).toBeLessThanOrEqual(REPORT_CONTEXT_MAX_CHARS)
    expect(boundedContext).toMatch(/BEGIN-GOAL/)
    expect(boundedContext).toMatch(/MIDDLE-DECISION/)
    expect(boundedContext).toMatch(/END-OUTCOME/)
    expect(boundedContext).toMatch(/context omitted/i)
  })
})

describe('report side-query wiring', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'report.ts'),
    'utf8',
  )

  test('uses a hard-bounded, text-only side request', () => {
    expect(source).toMatch(/queryWithModel\(\{/)
    expect(source).toMatch(/model:\s*context\.options\.mainLoopModel/)
    expect(source).toMatch(/querySource:\s*'report'/)
    expect(source).toMatch(/skipCacheWrite:\s*true/)
    expect(source).toMatch(/enablePromptCaching:\s*false/)
    expect(source).toMatch(/maxOutputTokensOverride: reportMaxOutputTokens\(/)
    expect(source).toMatch(
      /Math\.min\(REPORT_MAX_OUTPUT_TOKENS, getMaxOutputTokensForModel\(model\)\)/,
    )
    expect(source).not.toMatch(/temperatureOverride/)
    expect(source).not.toMatch(/runForkedAgent/)
    expect(source).not.toMatch(/getLastCacheSafeParams/)
    expect(source).not.toMatch(/getSmallFastModel/)
  })

  test('generates before resolving the output path', () => {
    expect(source.indexOf('await generateReportMarkdown')).toBeLessThan(
      source.indexOf('resolveOutputPath'),
    )
  })
})
