// Stub for the missing feishu vendor JCS canonicalizer.
// Consumed by vendored policy/fingerprint modules for stable digest inputs.
export function canonicalizeJcs(value: unknown): string {
  return JSON.stringify(value)
}
