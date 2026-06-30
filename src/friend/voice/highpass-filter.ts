/**
 * First-order IIR high-pass filter for DC offset removal and low-frequency noise rejection.
 *
 * Removes subsonic rumble, fan hum (50/60Hz), and AC line noise before VAD
 * processing — these are not human voice and can confuse the VAD model.
 *
 * Tuned for 16kHz sample rate with adjustable cutoff (~80Hz default).
 * Preserves all human voice frequencies (fundamental 85-255Hz + formants).
 *
 * Formula: y[n] = x[n] - x[n-1] + α ⋅ y[n-1]
 * where α = exp(-2π ⋅ fc / fs)
 */

export class HighPassFilter {
  private prevX = 0
  private prevY = 0
  private readonly alpha: number

  /**
   * @param cutoffHz  -3dB cutoff frequency in Hz (default: 80 — below male voice fundamental)
   * @param sampleRate  input sample rate (default: 16000 — Silero VAD sample rate)
   */
  constructor(cutoffHz = 80, sampleRate = 16000) {
    const omega = 2 * Math.PI * cutoffHz / sampleRate
    this.alpha = Math.exp(-omega)
  }

  /**
   * Process a Float32Array of audio samples in-place.
   * Zero-copy — mutates the input array.
   */
  process(samples: Float32Array): void {
    const a = this.alpha
    let x1 = this.prevX
    let y1 = this.prevY

    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i]
      const y0 = x0 - x1 + a * y1
      samples[i] = y0
      x1 = x0
      y1 = y0
    }

    this.prevX = x1
    this.prevY = y1
  }

  /** Reset filter state. Call when starting a new capture session. */
  reset(): void {
    this.prevX = 0
    this.prevY = 0
  }
}
