import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import figures from 'figures'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { analyzeContextFromSteps } from './ctx.js'
import {
  buildReportText,
  parseBenchmarkArgs,
  runBenchmark,
  type BenchmarkArgs,
  type BenchmarkProgress,
} from './runner.js'
import type { BenchmarkRun, ContextSuggestion } from './types.js'

/**
 * /benchmark —— 交互式 UI。
 *
 * 界面分区：
 *  1. 顶栏：数据集 / model / phase
 *  2. 运行区：当前 query 的实时 step（OpenSeeker tool loop）
 *  3. 完成区：已有结果的 ✔/✘ 与 score（LLM-as-judge / ABSeeker 打分）
 *  4. Context 区：LongSeeker 式压缩/删除/回退建议
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  return <BenchmarkUI onClose={onDone} args={parseBenchmarkArgs(args)} />
}

const PHASE_LABEL: Record<BenchmarkProgress['phase'], string> = {
  loading: 'loading dataset',
  running: 'running ReAct search loop',
  evaluating: 'LLM-as-judge evaluation',
  scoring: 'step scoring (ABSeeker)',
  analyzing: 'context analysis (LongSeeker)',
  done: 'done',
  error: 'error',
}

type Props = {
  onClose: (result?: string) => void
  args: BenchmarkArgs
}

export function BenchmarkUI({ onClose, args }: Props) {
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null)
  const [run, setRun] = useState<BenchmarkRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runRef = useRef<BenchmarkRun | null>(null)
  runRef.current = run

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === 'c' || input === 'd'))) {
      const r = runRef.current
      onClose(r ? buildReportText(r) : undefined)
    }
  })

  useEffect(() => {
    let active = true
    runBenchmark({
      args,
      onProgress: p => {
        if (!active) return
        setProgress(p)
        if (p.phase === 'error') setError(p.message ?? 'unknown error')
      },
    })
      .then(r => {
        if (!active) return
        setRun(r)
      })
      .catch((err: unknown) => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const p = progress
  const done = run !== null

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>
          /benchmark · {p?.datasetName ?? args.dataset}
        </Text>
        <Text color="subtle">
          model={args.model} max-steps={args.maxSteps}{' '}
          {p ? `· ${PHASE_LABEL[p.phase]}` : 'starting…'}
        </Text>
      </Box>

      {error && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="error">
            {figures.cross} {error}
          </Text>
          <Text color="subtle" dimColor>press <Text bold>esc</Text> to close</Text>
        </Box>
      )}

      {/* 运行中的当前 query */}
      {!done && p && p.phase === 'running' && p.current > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>
            ({p.current}/{p.total}) {p.currentId}{' '}
            <Text color="subtle" wrap="truncate">{p.currentQuery}</Text>
          </Text>
          <Box marginLeft={2}>
            <StepLabel action={p.currentAction} step={p.currentSteps} />
            <Text color="subtle" dimColor>
              {' '}ctx ≈ {(p.currentCtxTokens / 1000).toFixed(1)}k tok
            </Text>
          </Box>
        </Box>
      ) : !done && p && p.current > 0 ? (
        <Box marginBottom={1} marginLeft={2}>
          <Text color="subtle">
            {p.current}/{p.total} {p.currentId} · {PHASE_LABEL[p.phase]}…
          </Text>
        </Box>
      ) : null}

      {/* 已完成条目（运行期预览；结束后由报告区替代） */}
      {!done && p && p.trajectories.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="subtle">
            Completed
          </Text>
          {p.trajectories.map(t => {
            const judged = t.judged
            const mark =
              judged === null ? figures.ellipsis : judged.correct ? figures.tick : figures.cross
            const color = judged === null ? 'subtle' : judged.correct ? 'success' : 'error'
            return (
              <Box key={t.id} marginLeft={2}>
                <Text color={color} bold>{mark}</Text>
                <Text>
                  {' '}
                  {t.id} · {t.steps.length} steps ·{' '}
                  {Math.round((t.steps.at(-1)?.contextTokensAfter ?? 0) / 100) / 10}k tok
                  {judged !== null && (
                    <Text color="subtle"> · score {judged.score.toFixed(1)}</Text>
                  )}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}

      {/* 最终报告 */}
      {done && run && <BenchmarkReport run={run} />}

      {!done && !error && (
        <Text color="subtle" dimColor>{figures.arrowDown} esc to cancel</Text>
      )}
    </Box>
  )
}

function StepLabel({ action, step }: { action: string; step: number }) {
  if (action === 'search_web') {
    return (
      <Text color="accent">{figures.pointer} step {step} · searching…</Text>
    )
  }
  if (action === 'visit_web') {
    return (
      <Text color="accent">{figures.pointer} step {step} · reading page…</Text>
    )
  }
  if (action === 'answer') {
    return (
      <Text color="success">{figures.pointer} step {step} · answering…</Text>
    )
  }
  return <Text color="subtle">step {step} · {action}</Text>
}

function BenchmarkReport({ run }: { run: BenchmarkRun }) {
  const correct = run.trajectories.filter(t => t.judged?.correct).length
  const n = Math.max(1, run.trajectories.length)
  const avgScore = run.trajectories.reduce((a, t) => a + (t.judged?.score ?? 0), 0) / n
  const avgSteps =
    run.trajectories.reduce((a, t) => a + Math.max(1, t.steps.length), 0) / n
  const avgCtx =
    run.trajectories.reduce((a, t) => a + (t.steps.at(-1)?.contextTokensAfter ?? 0), 0) / n
  const suggestions: { qid: string; s: ContextSuggestion }[] = run.trajectories.flatMap(t =>
    analyzeContextFromSteps(t).suggestions.map(s => ({ qid: t.id, s })),
  )

  return (
    <Box flexDirection="column">
      <Text bold color={correct > 0 ? 'success' : 'subtle'}>
        {correct}/{run.trajectories.length} correct
        <Text color="subtle">
          {' '}· avg score {avgScore.toFixed(2)} · avg {avgSteps.toFixed(1)} steps · avg{' '}
          {(avgCtx / 1000).toFixed(1)}k ctx
        </Text>
      </Text>

      {/* 明细表 */}
      <Box flexDirection="column" marginTop={1}>
        {run.trajectories.map(t => {
          const judged = t.judged
          const mark = judged === null ? figures.ellipsis : judged.correct ? figures.tick : figures.cross
          const color = judged === null ? 'subtle' : judged.correct ? 'success' : 'error'
          return (
            <Box key={t.id} marginLeft={1}>
              <Text color={color} bold>{mark}</Text>
              <Text>
                {' '}{t.id} <Text color="subtle" dimColor>·</Text>{' '}
                {judged?.score.toFixed(1) ?? 'n/a'} <Text color="subtle" dimColor>·</Text>{' '}
                {t.steps.length} steps <Text color="subtle" dimColor>·</Text>{' '}
                {Math.round((t.steps.at(-1)?.contextTokensAfter ?? 0) / 100) / 10}k tok
                {t.error && <Text color="warning"> · {t.error}</Text>}
              </Text>
            </Box>
          )
        })}
      </Box>

      {/* LongSeeker context 建议 */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="subtle">
          Context suggestions (LongSeeker meta-ops)
        </Text>
        {suggestions.length === 0 ? (
          <Text color="subtle" marginLeft={2}>none — context stayed small</Text>
        ) : (
          suggestions.slice(0, 12).map((item, i) => (
            <SuggestionLine key={`${item.qid}-${i}`} qid={item.qid} s={item.s} />
          ))
        )}
      </Box>

      <Text color="subtle" dimColor marginTop={1}>
        saved: {run.runDir}
        {'\n'}press <Text bold>esc</Text> to close
      </Text>
    </Box>
  )
}

function SuggestionLine({ qid, s }: { qid: string; s: ContextSuggestion }) {
  const icon =
    s.kind === 'compress' ? 'Σ'
    : s.kind === 'delete' ? figures.cross
    : s.kind === 'rollback' ? figures.arrowLeft
    : '…'
  const color =
    s.kind === 'delete' ? 'error' : s.kind === 'rollback' ? 'accent' : 'warning'
  return (
    <Box marginLeft={2}>
      <Text color={color}>
        {icon} {qid} {s.kind}@{s.step}{' '}
        <Text color="subtle">({(s.contextTokens / 1000).toFixed(1)}k tok)</Text>
      </Text>
      <Text color="subtle" dimColor> {s.reason}</Text>
    </Box>
  )
}