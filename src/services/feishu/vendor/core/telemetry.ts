/** Minimal telemetry — noop */

export type TelemetryAdapter = {
  emit(): void
  recordError(): void
  recordMetric(): void
  flush?(): void
  close?(): void
}

const noop: TelemetryAdapter = {
  emit() {},
  recordError() {},
  recordMetric() {},
  flush() {},
  close() {},
}

let active: TelemetryAdapter = noop

export function telemetry(): TelemetryAdapter {
  return active
}

export async function loadTelemetryAdapter(_meta: unknown): Promise<void> {
  // noop
}
