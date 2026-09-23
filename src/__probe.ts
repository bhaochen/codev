type Verdict = { ok: true } | { ok: false; error: string }
declare const onSetPermissionMode: ((m: string) => Verdict) | undefined
declare const mode: string
const verdict = onSetPermissionMode?.(mode) ?? {
  ok: false as const,
  error: 'unsupported',
}
if (verdict.ok === true) {
  // ok
} else {
  const e: string = verdict.error
  void e
}