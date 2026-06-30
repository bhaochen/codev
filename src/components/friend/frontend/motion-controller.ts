/**
 * MotionController — unified animation system supporting VRMA and FBX actions.
 *
 * Uses a single persistent AnimationMixer with crossFade transitions to avoid
 * T-pose flickering between animations.
 *
 * Simplified: removed dance system, kept action presets for human-like behavior.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'
import type { VRMAnimation } from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import { loadMixamoAnimation } from './mixamo-loader'

// ── Motion file types ───────────────────────────────────────────────────────

export type MotionFileType = 'vrma' | 'fbx'

// ── Motion presets ──────────────────────────────────────────────────────────

export interface MotionPreset {
  label: string
  type: MotionFileType
  url: string
}

// Actions: short one-shot gestures triggered by emotions / interactions
export const actionPresets: Record<string, MotionPreset> = {
  akimbo:       { label: '叉腰',   type: 'vrma', url: '/friend/akimbo.vrma' },
  playFingers:  { label: '搓手',   type: 'vrma', url: '/friend/playFingers.vrma' },
  scratchHead:  { label: '挠头',   type: 'vrma', url: '/friend/scratchHead.vrma' },
  stretch:      { label: '伸展',   type: 'vrma', url: '/friend/stretch.vrma' },

  happy:        { label: '开心',     type: 'fbx', url: '/friend/happy.fbx' },
  angry:        { label: '生气',     type: 'fbx', url: '/friend/angry.fbx' },
  greeting:     { label: '招呼',     type: 'fbx', url: '/friend/greeting.fbx' },
  excited:      { label: '兴奋',     type: 'fbx', url: '/friend/excited.fbx' },
  shy:          { label: '害羞',     type: 'fbx', url: '/friend/shy.fbx' },
  point:        { label: '指点',     type: 'fbx', url: '/friend/point.fbx' },
  salute:       { label: '敬礼',     type: 'fbx', url: '/friend/salute.fbx' },
  angryPump:    { label: '暴怒',     type: 'fbx', url: '/friend/angryPump.fbx' },
}

// ── Utility: re-anchor root position ────────────────────────────────────────

function reAnchorRootPositionTrack(clip: THREE.AnimationClip, vrm: VRM) {
  const hipNode = vrm.humanoid?.getNormalizedBoneNode('hips')
  if (!hipNode) return

  hipNode.updateMatrixWorld(true)
  const defaultHipPos = new THREE.Vector3()
  hipNode.getWorldPosition(defaultHipPos)

  const hipsTrack = clip.tracks.find(
    (t) =>
      t instanceof THREE.VectorKeyframeTrack &&
      t.name === `${hipNode.name}.position`,
  )
  if (!(hipsTrack instanceof THREE.VectorKeyframeTrack)) return

  const animeHipPos = new THREE.Vector3(
    hipsTrack.values[0],
    hipsTrack.values[1],
    hipsTrack.values[2],
  )
  const delta = new THREE.Vector3().subVectors(animeHipPos, defaultHipPos)

  clip.tracks.forEach((track) => {
    if (
      track.name.endsWith('.position') &&
      track instanceof THREE.VectorKeyframeTrack
    ) {
      for (let i = 0; i < track.values.length; i += 3) {
        track.values[i] -= delta.x
        track.values[i + 1] -= delta.y
        track.values[i + 2] -= delta.z
      }
    }
  })
}

// ── MotionController ────────────────────────────────────────────────────────

export class MotionController {
  private vrm: VRM
  private mixer: THREE.AnimationMixer | null = null
  private idleClip: THREE.AnimationClip | null = null
  private idleAction: THREE.AnimationAction | null = null
  private currentAction: THREE.AnimationAction | null = null
  private clipCache = new Map<string, THREE.AnimationClip>()
  private gltfLoader: GLTFLoader
  private _actionPlaying = false
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private _actionSafetyTimer: ReturnType<typeof setTimeout> | null = null
  private actionQueue: Array<{ name: string; hold: boolean }> = []
  private _settleGen = 0       // generation at which the current settle is valid
  private _settleHold = false  // hold flag for current settle

  constructor(vrm: VRM) {
    this.vrm = vrm
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.gltfLoader = new GLTFLoader()
    this.gltfLoader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  }

  get actionPlaying() { return this._actionPlaying }

  update(delta: number) {
    if (this.mixer) {
      this.mixer.update(delta)
      this.checkActionCompletion()
    }
  }

  /**
   * Frame-accurate action completion detection.
   * THREE.AnimationMixer 'finished' event only fires when ALL actions finish,
   * which never happens with a looping idle. So we check per-frame instead.
   */
  private checkActionCompletion() {
    if (!this._actionPlaying || !this.currentAction) return
    const clip = this.currentAction.getClip()
    if (!clip || clip.duration <= 0) return

    // Allow a 1-frame epsilon (≈16ms at 60fps) to avoid precision issues
    if (this.currentAction.time >= clip.duration - 0.02) {
      this.finishCurrentAction()
    }
  }

  // ── CrossFade helper ─────────────────────────────────────────────────────

  private crossFadeTo(newAction: THREE.AnimationAction, duration = 0.3) {
    newAction.reset().setEffectiveWeight(1).play()
    const prev = this.currentAction ?? this.idleAction
    if (prev && prev !== newAction) {
      prev.crossFadeTo(newAction, duration, false)
    }
    this.currentAction = newAction
  }

  // ── Load & play idle animation ───────────────────────────────────────────

  async loadIdle(path: string) {
    const clip = await this.loadVRMA(path)
    if (!clip) return
    reAnchorRootPositionTrack(clip, this.vrm)
    this.idleClip = clip
    this.startIdle()
  }

  /** (Re)start idle via crossFade. */
  private startIdle() {
    if (!this.idleClip || !this.mixer) return
    this.idleAction = this.mixer.clipAction(this.idleClip)
    this.crossFadeTo(this.idleAction)
  }

  // ── Clear current action (private) ──────────────────────────────────────

  private clearTimers() {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null }
    if (this._actionSafetyTimer) { clearTimeout(this._actionSafetyTimer); this._actionSafetyTimer = null }
  }

  // ── Reset to idle (public) ──────────────────────────────────────────────

  resetToIdle() {
    this.clearTimers()
    this._actionPlaying = false
    this._actionGeneration++

    // CrossFade back to idle
    if (this.mixer && this.idleClip) {
      this.idleAction = this.mixer.clipAction(this.idleClip)
      this.crossFadeTo(this.idleAction)
    }
  }

  // ── Play a one-shot action ──────────────────────────────────────────────

  private _actionGeneration = 0

  async playAction(name: string, hold = false) {
    const preset = actionPresets[name]
    if (!preset) { console.warn('[Motion] unknown action:', name); return }

    // If already playing an action, queue instead of dropping
    if (this._actionPlaying) {
      // Avoid duplicate consecutive queued items
      const last = this.actionQueue[this.actionQueue.length - 1]
      if (!last || last.name !== name) {
        this.actionQueue.push({ name, hold })
      }
      return
    }

    // Set lock BEFORE async load to prevent concurrent playAction calls
    this._actionPlaying = true
    const gen = ++this._actionGeneration
    this._settleGen = gen
    this._settleHold = hold

    const clip = await this.loadClip(preset)

    // Check if state was reset or another action started during await
    if (gen !== this._actionGeneration) return
    if (!clip) { console.warn('[Motion] clip load failed for:', name); this._actionPlaying = false; return }
    if (!this.mixer) { this._actionPlaying = false; return }

    this.clearTimers()

    const action = this.mixer.clipAction(clip)
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    this.crossFadeTo(action)

    // Frame-accurate completion is handled in checkActionCompletion() via update()
    // Safety timer: generous fallback (should never fire if checkActionCompletion works)
    const safeDuration = Math.max(clip.duration, 3) + 5
    this._actionSafetyTimer = setTimeout(() => {
      if (gen === this._actionGeneration && this._actionPlaying) {
        this.finishCurrentAction()
      }
    }, safeDuration * 1000)
  }

  /** Called by checkActionCompletion() or safety timer when current action ends. */
  private finishCurrentAction() {
    if (!this._actionPlaying) return
    this.clearTimers()
    const gen = this._settleGen
    const hold = this._settleHold

    if (gen !== this._actionGeneration) return

    // Process next queued action
    const next = this.actionQueue.shift()
    if (next) {
      this._actionPlaying = false
      this.playAction(next.name, next.hold)
      return
    }

    if (hold) {
      this.holdTimer = setTimeout(() => {
        if (gen !== this._actionGeneration) return
        this._actionPlaying = false
        this.startIdle()
      }, 10000)
    } else {
      this._actionPlaying = false
      this.startIdle()
    }
  }

  /** Cleanup when controller is being destroyed (model reload etc.) */
  dispose() {
    this.clearTimers()
    this._actionPlaying = false
    this._actionGeneration++
    if (this.mixer) {
      this.mixer.stopAllAction()
      this.mixer.uncacheRoot(this.vrm.scene)
      this.mixer = null
    }
    this.idleAction = null
    this.currentAction = null
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async loadClip(preset: MotionPreset): Promise<THREE.AnimationClip | null> {
    const cached = this.clipCache.get(preset.url)
    if (cached) return cached

    let clip: THREE.AnimationClip | null = null

    try {
      switch (preset.type) {
        case 'vrma':
          clip = await this.loadVRMA(preset.url)
          if (clip) reAnchorRootPositionTrack(clip, this.vrm)
          break
        case 'fbx':
          clip = await loadMixamoAnimation(preset.url, this.vrm)
          break
      }
    } catch (err) {
      console.error('Failed to load clip:', preset.url, err)
      return null
    }

    if (clip) {
      clip.name = preset.url
      this.clipCache.set(preset.url, clip)
    }
    return clip
  }

  private async loadVRMA(url: string): Promise<THREE.AnimationClip | null> {
    try {
      const gltf = await this.gltfLoader.loadAsync(url)
      const anims = gltf.userData.vrmAnimations as VRMAnimation[]
      if (anims?.length) {
        return createVRMAnimationClip(anims[0], this.vrm)
      }
    } catch (err) {
      console.warn(`Failed to load VRMA: ${url}`, err)
    }
    return null
  }
}
