import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import { EmoteController } from '../emote'
import { LipSync } from '../lip-sync'
import { MotionController } from '../motion-controller'

interface VRMSceneProps {
  modelPath: string
  idleAnimationPath?: string
}

export type TrackingMode = 'mouse' | 'camera'

export interface VRMSceneHandle {
  setEmotion: (emotion: string, intensity?: number) => void
  setEmotionWithReset: (emotion: string, durationMs: number, intensity?: number) => void
  resetCamera: () => void
  setTrackingMode: (mode: TrackingMode) => void
  playAction: (name: string, hold?: boolean) => void
  panCamera: (dx: number, dy: number) => void
  rotateCamera: (dx: number, dy: number) => void
  /** Unified reset: camera + resetToIdle + expressions to zero */
  reset: () => void
}

// ── Blink state ───────────────────────────────────────────────────────────────
interface BlinkState {
  isBlinking: boolean
  blinkProgress: number
  timeSinceLastBlink: number
  nextBlinkTime: number
  blinkDuration: number
  doubleBlink: boolean
  doubleBlinkCount: number
}

function createBlinkState(): BlinkState {
  return {
    isBlinking: false,
    blinkProgress: 0,
    timeSinceLastBlink: 0,
    nextBlinkTime: Math.random() * 5 + 2,
    blinkDuration: 0.1 + Math.random() * 0.08,
    doubleBlink: false,
    doubleBlinkCount: 0,
  }
}

function updateBlink(vrm: VRM, delta: number, state: BlinkState) {
  if (!vrm.expressionManager) return

  state.timeSinceLastBlink += delta

  if (!state.isBlinking && state.timeSinceLastBlink >= state.nextBlinkTime) {
    state.isBlinking = true
    state.blinkProgress = 0
    state.blinkDuration = 0.08 + Math.random() * 0.12
    // ~8% chance of double blink (more natural)
    state.doubleBlink = Math.random() < 0.08
    state.doubleBlinkCount = 0
  }

  if (state.isBlinking) {
    state.blinkProgress += delta / state.blinkDuration
    const blinkValue = Math.sin(Math.PI * state.blinkProgress)
    vrm.expressionManager.setValue('blink', blinkValue)

    if (state.blinkProgress >= 1) {
      state.blinkProgress = 0
      state.doubleBlinkCount++

      if (state.doubleBlink && state.doubleBlinkCount < 2) {
        // Quick reopen then re-blink
        vrm.expressionManager.setValue('blink', 0)
        state.blinkDuration = 0.06 + Math.random() * 0.06
      } else {
        state.isBlinking = false
        state.timeSinceLastBlink = 0
        vrm.expressionManager.setValue('blink', 0)
        state.doubleBlink = false
        state.nextBlinkTime = Math.random() * 6 + 1.5
      }
    }
  }
}

// ── Relaxed hand pose ─────────────────────────────────────────────────────────

interface HandPoseCache {
  bones: { bone: THREE.Object3D; z: number; y: number }[]
}

function buildHandPoseCache(vrm: VRM): HandPoseCache {
  const humanoid = vrm.humanoid
  const bones: HandPoseCache['bones'] = []
  if (!humanoid) return { bones }

  const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const
  const segments = ['Proximal', 'Intermediate', 'Distal'] as const
  const sides = ['left', 'right'] as const

  const curlMap: Record<string, [number, number, number]> = {
    Thumb:  [0.25, 0.15, 0.10],
    Index:  [0.20, 0.30, 0.20],
    Middle: [0.25, 0.35, 0.25],
    Ring:   [0.30, 0.40, 0.30],
    Little: [0.35, 0.45, 0.30],
  }

  const spreadMap: Record<string, number> = {
    Thumb:  0.15,
    Index:  0.04,
    Middle: 0.0,
    Ring:   -0.04,
    Little: -0.08,
  }

  for (const side of sides) {
    const sign = side === 'left' ? 1 : -1

    for (const finger of fingers) {
      const curls = curlMap[finger]
      const spread = spreadMap[finger]

      for (let s = 0; s < segments.length; s++) {
        const boneName = `${side}${finger}${segments[s]}` as any
        const bone = humanoid.getNormalizedBoneNode(boneName)
        if (!bone) continue

        const z = sign * curls[s]
        const y = s === 0 ? sign * spread : 0

        bones.push({ bone, z, y })
      }
    }
  }

  return { bones }
}

function applyRelaxedHandPose(cache: HandPoseCache, time: number) {
  // Slow hand tension cycle (~30s period): hands subtly change posture over time
  const tensionCycle = 0.5 + 0.5 * Math.sin(time * 0.035)
  const zScale = 0.85 + tensionCycle * 0.3  // 0.85-1.15

  for (const { bone, z, y } of cache.bones) {
    const freq = 0.3 + Math.abs(z) * 2
    const micro = Math.sin(time * freq + z * 50) * 0.02
    bone.rotation.z = z * zScale + micro
    if (y !== 0) bone.rotation.y = y
  }
}

export const VRMScene = forwardRef<VRMSceneHandle, VRMSceneProps>(function VRMScene({
  modelPath,
  idleAnimationPath = '/friend/idle_loop.vrma',
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const emoteRef = useRef<EmoteController | null>(null)
  const resetCameraRef = useRef<(() => void) | null>(null)
  const trackingModeRef = useRef<TrackingMode>('mouse')
  const motionRef = useRef<MotionController | null>(null)
  const panCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const rotateCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const lipSyncRef = useRef<LipSync>(LipSync.getInstance())

  useImperativeHandle(ref, () => ({
    setEmotion(emotion: string, intensity?: number) {
      emoteRef.current?.setEmotion(emotion, intensity)
    },
    setEmotionWithReset(emotion: string, durationMs: number, intensity?: number) {
      emoteRef.current?.setEmotionWithReset(emotion, durationMs, intensity)
    },
    resetCamera() {
      resetCameraRef.current?.()
    },
    setTrackingMode(mode: TrackingMode) {
      trackingModeRef.current = mode
    },
    playAction(name: string, hold?: boolean) {
      motionRef.current?.playAction(name, hold)
    },
    panCamera(dx: number, dy: number) {
      panCameraRef.current?.(dx, dy)
    },
    rotateCamera(dx: number, dy: number) {
      rotateCameraRef.current?.(dx, dy)
    },
    reset() {
      resetCameraRef.current?.()
      motionRef.current?.resetToIdle()
      emoteRef.current?.resetAll()
    },
  }))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000, 0)

    // ── Scene ─────────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()

    // ── Camera ────────────────────────────────────────────────────────────────
    const FOV = 40
    const camera = new THREE.PerspectiveCamera(
      FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    )
    const pivot = new THREE.Vector3(0, 0, 0)
    let orbitRadius = 2.0
    let orbitTheta = 0
    let orbitPhi = Math.PI / 2

    function updateCameraOrbit() {
      camera.position.set(
        pivot.x + orbitRadius * Math.sin(orbitPhi) * Math.sin(orbitTheta),
        pivot.y + orbitRadius * Math.cos(orbitPhi),
        pivot.z + orbitRadius * Math.sin(orbitPhi) * Math.cos(orbitTheta),
      )
      camera.lookAt(pivot)
    }
    updateCameraOrbit()

    // ── Lights ────────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(1, 2, 3)
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-2, 1, -1)
    scene.add(fillLight)

    // ── Loader ───────────────────────────────────────────────────────────────
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    // ── State ─────────────────────────────────────────────────────────────────
    let vrm: VRM | null = null
    let motion: MotionController | null = null
    let emote: EmoteController | null = null
    let handPose: HandPoseCache | null = null
    const blinkState = createBlinkState()
    const saccades = new EyeSaccadeController()
    const lookAtTarget = { x: 0, y: 0, z: -100 }

    // ── Aliveness system state: breathing, sway, speech micro-movements ─────
    let alivenessBones = { chestBone: null as THREE.Object3D | null, spineBone: null as THREE.Object3D | null, neckBone: null as THREE.Object3D | null }
    let breathPhase = Math.random() * Math.PI * 2
    let swayPhase = Math.random() * Math.PI * 2
    let speechBlend = 0
    let userListenBlend = 0
    // Micro-expression state
    let microTimer = 5 + Math.random() * 10
    let microActive = false
    let microPhase = 0
    let microShape = ''

    // ── Load VRM model, then load idle animation ─────────────────────────────
    loader.load(
      modelPath,
      async (gltf) => {
        const loadedVrm = gltf.userData.vrm as VRM
        if (!loadedVrm) {
          console.error('No VRM data found in GLTF')
          return
        }

        VRMUtils.removeUnnecessaryVertices(loadedVrm.scene)
        VRMUtils.combineSkeletons(loadedVrm.scene)
        loadedVrm.scene.traverse((obj) => {
          obj.frustumCulled = false
        })

        if (loadedVrm.lookAt) {
          const lookAtQuatProxy = new VRMLookAtQuaternionProxy(loadedVrm.lookAt)
          lookAtQuatProxy.name = 'lookAtQuaternionProxy'
          loadedVrm.scene.add(lookAtQuatProxy)
        }

        VRMUtils.rotateVRM0(loadedVrm)

        scene.add(loadedVrm.scene)
        vrm = loadedVrm

        // ── Compute camera from model bounds ───────────────────
        const box = new THREE.Box3().setFromObject(loadedVrm.scene)
        const modelSize = new THREE.Vector3()
        const modelCenter = new THREE.Vector3()
        box.getSize(modelSize)
        box.getCenter(modelCenter)
        modelCenter.y += modelSize.y / 3.2

        const radians = (FOV / 2 * Math.PI) / 180
        const offsetX = modelSize.x / 16
        const offsetY = modelSize.y / 10
        const offsetZ = (modelSize.y / 4.2) / Math.tan(radians)

        pivot.copy(modelCenter)
        orbitRadius = offsetZ
        orbitTheta = Math.atan2(offsetX, offsetZ)
        orbitPhi = Math.PI / 2 - Math.atan2(offsetY, offsetZ)
        updateCameraOrbit()

        const initPivot = pivot.clone()
        const initRadius = orbitRadius
        const initTheta = orbitTheta
        const initPhi = orbitPhi
        resetCameraRef.current = () => {
          pivot.copy(initPivot)
          orbitRadius = initRadius
          orbitTheta = initTheta
          orbitPhi = initPhi
          updateCameraOrbit()
        }

        panCameraRef.current = (dx: number, dy: number) => {
          const right = new THREE.Vector3()
          const up = new THREE.Vector3()
          camera.getWorldDirection(new THREE.Vector3())
          right.setFromMatrixColumn(camera.matrixWorld, 0)
          up.setFromMatrixColumn(camera.matrixWorld, 1)
          pivot.addScaledVector(right, -dx * 0.003)
          pivot.addScaledVector(up, dy * 0.003)
          updateCameraOrbit()
        }

        rotateCameraRef.current = (dx: number, dy: number) => {
          orbitTheta -= dx * 0.005
          orbitPhi = THREE.MathUtils.clamp(
            orbitPhi - dy * 0.005,
            0.1,
            Math.PI - 0.1,
          )
          updateCameraOrbit()
        }

        handPose = buildHandPoseCache(loadedVrm)

        // ── Initialize aliveness bone references ──
        const h = loadedVrm.humanoid
        alivenessBones = {
          chestBone: h?.getNormalizedBoneNode('chest') ?? null,
          spineBone: h?.getNormalizedBoneNode('spine') ?? null,
          neckBone: h?.getNormalizedBoneNode('neck') ?? null,
        }

        emote = new EmoteController(loadedVrm)
        emoteRef.current = emote

        motion = new MotionController(loadedVrm)
        motionRef.current = motion

        motion.loadIdle(idleAnimationPath).catch((err) =>
          console.warn('Failed to load idle animation:', err),
        )

        loadedVrm.springBoneManager?.reset()
      },
      () => {},
      (err) => {
        console.error('Failed to load VRM:', err)
      },
    )

    // ── Mouse tracking ────────────────────────────────────────────────────────
    const mouse = new THREE.Vector2(0, 0)
    const _raycaster = new THREE.Raycaster()
    const _mouseVec = new THREE.Vector2()

    function onMouseMove(e: MouseEvent) {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1

      if (trackingModeRef.current !== 'mouse') return

      _mouseVec.set(mouse.x, mouse.y)
      _raycaster.setFromCamera(_mouseVec, camera)
      const camDir = new THREE.Vector3()
      camera.getWorldDirection(camDir)
      const plane = new THREE.Plane()
      plane.setFromNormalAndCoplanarPoint(
        camDir,
        camera.position.clone().add(camDir.multiplyScalar(1)),
      )
      const intersection = new THREE.Vector3()
      if (_raycaster.ray.intersectPlane(plane, intersection)) {
        lookAtTarget.x = intersection.x
        lookAtTarget.y = intersection.y
        lookAtTarget.z = intersection.z
        if (vrm) {
          saccades.instantUpdate(vrm, lookAtTarget)
        }
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mousemove', onMouseMove)

    // ── Scroll zoom ──────────────────────────────────────────────────────────
    const MIN_RADIUS = 0.8
    const MAX_RADIUS = 5.0
    const ZOOM_SPEED = 0.002

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      orbitRadius = THREE.MathUtils.clamp(
        orbitRadius + e.deltaY * ZOOM_SPEED,
        MIN_RADIUS,
        MAX_RADIUS,
      )
      updateCameraOrbit()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // ── Camera drag controls ──────────────────────────────────────────────
    let dragMode: 'rotate' | 'dolly' | null = null
    let prevX = 0
    let prevY = 0
    const ROTATE_SPEED = 0.005
    const DOLLY_SPEED = 0.01

    function onPointerDown(e: PointerEvent) {
      if (e.button === 1) {
        dragMode = 'dolly'
        e.preventDefault()
      } else if (e.button === 2) {
        dragMode = 'rotate'
      } else {
        return
      }
      prevX = e.clientX
      prevY = e.clientY
      canvas!.setPointerCapture(e.pointerId)
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragMode) return
      const dx = e.clientX - prevX
      const dy = e.clientY - prevY
      prevX = e.clientX
      prevY = e.clientY

      if (dragMode === 'rotate') {
        orbitTheta -= dx * ROTATE_SPEED
        orbitPhi = THREE.MathUtils.clamp(
          orbitPhi - dy * ROTATE_SPEED,
          0.1,
          Math.PI - 0.1,
        )
      } else if (dragMode === 'dolly') {
        orbitRadius = THREE.MathUtils.clamp(
          orbitRadius + dy * DOLLY_SPEED,
          MIN_RADIUS,
          MAX_RADIUS,
        )
      }
      updateCameraOrbit()
    }

    function onPointerUp() {
      if (dragMode) {
        dragMode = null
      }
    }

    function onContextMenu(e: Event) {
      e.preventDefault()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('contextmenu', onContextMenu)

    // ── Resize ────────────────────────────────────────────────────────────────
    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)

    // ── Animation loop ────────────────────────────────────────────────────────
    const clock = new THREE.Clock()
    let animFrameId: number

    function animate() {
      animFrameId = requestAnimationFrame(animate)
      const delta = clock.getDelta()

      if (vrm) {
        motion?.update(delta)

        if (handPose) applyRelaxedHandPose(handPose, clock.elapsedTime)

        vrm.humanoid?.update()

        if (trackingModeRef.current === 'camera') {
          lookAtTarget.x = camera.position.x
          lookAtTarget.y = camera.position.y
          lookAtTarget.z = camera.position.z
          saccades.instantUpdate(vrm, lookAtTarget)
        }

        vrm.lookAt?.update(delta)
        saccades.update(vrm, lookAtTarget, delta)
        updateBlink(vrm, delta, blinkState)
        emote?.update(delta)
        lipSyncRef.current.update(vrm, delta)

        // ── Aliveness: micro-expressions (asymmetric blink, subtle morphs) ──
        microTimer -= delta
        if (microTimer <= 0 && !microActive) {
          microShape = Math.random() > 0.5 ? 'blinkLeft' : 'blinkRight'
          microActive = true
          microPhase = 0
        }
        if (microActive && vrm.expressionManager) {
          microPhase += delta * 4
          const val = Math.sin(Math.PI * Math.min(microPhase, 1))
          vrm.expressionManager.setValue(microShape, val * 0.3)
          if (microPhase >= 2) {
            microActive = false
            vrm.expressionManager.setValue(microShape, 0)
            microTimer = 8 + Math.random() * 16
          }
        }

        vrm.expressionManager?.update()
        vrm.springBoneManager?.update(delta)

        // ── Aliveness: breathing (chest rise/fall, post-mixer) ──
        // Breathing rate varies naturally, amplitude tuned for VRM scale
        const breathRate = 1.8 + Math.sin(breathPhase * 0.05) * 0.4 + Math.sin(clock.elapsedTime * 0.1) * 0.3
        breathPhase += delta * breathRate
        const breathVal = Math.sin(breathPhase) * 0.006
        if (alivenessBones.chestBone) {
          alivenessBones.chestBone.position.y += breathVal
        }

        // ── Aliveness: postural sway ──
        swayPhase += delta * 0.35
        const swayZ = Math.sin(swayPhase) * 0.005
        if (alivenessBones.spineBone) {
          alivenessBones.spineBone.rotation.z += swayZ
        }

        // ── Aliveness: speech-driven micro-movements ──
        const isSpeaking = lipSyncRef.current.isActive()
        const targetBlend = isSpeaking ? 1 : 0
        speechBlend += (targetBlend - speechBlend) * Math.min(1, delta * 3)
        if (speechBlend > 0.01) {
          const t = clock.elapsedTime
          const headX = Math.sin(t * 3.7 + 1.2) * 0.02 * speechBlend
          const headZ = Math.sin(t * 2.3 + 0.7) * 0.015 * speechBlend
          const headY = Math.sin(t * 1.5 + 3.8) * 0.008 * speechBlend  // slight rotation (looking around while talking)
          const spineSway = Math.sin(t * 1.8 + 0.3) * 0.006 * speechBlend
          if (alivenessBones.neckBone) {
            alivenessBones.neckBone.rotation.x += headX
            alivenessBones.neckBone.rotation.z += headZ
            alivenessBones.neckBone.rotation.y += headY
          }
          if (alivenessBones.spineBone) {
            alivenessBones.spineBone.rotation.x += spineSway
          }
        }

        // ── Aliveness: listening response when user is speaking ──
        const isUserSpeaking = !!(window as any).__userRecording
        userListenBlend += ((isUserSpeaking ? 1 : 0) - userListenBlend) * Math.min(1, delta * 2)
        if (userListenBlend > 0.01) {
          const t = clock.elapsedTime
          const listenTilt = Math.sin(t * 0.9 + 0.5) * 0.012 * userListenBlend  // head tilt
          const listenNod = Math.sin(t * 2.3 + 3.1) * 0.008 * userListenBlend    // subtle nodding
          if (alivenessBones.neckBone) {
            alivenessBones.neckBone.rotation.z += listenTilt
            alivenessBones.neckBone.rotation.x += listenNod
          }
        }
      }

      renderer.render(scene, camera)
    }

    animate()

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animFrameId)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('resize', onResize)
      emote?.dispose()
      emoteRef.current = null
      motion?.dispose()
      motionRef.current = null
      delete (window as any).__clawHitTest
      renderer.dispose()
    }
  }, [modelPath, idleAnimationPath])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          background: 'transparent',
          cursor: 'grab',
        }}
      />
    </div>
  )
})

// ── Eye saccade interval ─────────────────────────────────────────
const EYE_SACCADE_INT_STEP = 400
const EYE_SACCADE_INT_P: number[][] = [
  [0.075, 800], [0.110, 0], [0.125, 0], [0.140, 0], [0.125, 0],
  [0.050, 0],   [0.040, 0], [0.030, 0], [0.020, 0], [1.000, 0],
]
for (let i = 1; i < EYE_SACCADE_INT_P.length; i++) {
  EYE_SACCADE_INT_P[i][0] += EYE_SACCADE_INT_P[i - 1][0]
  EYE_SACCADE_INT_P[i][1] = EYE_SACCADE_INT_P[i - 1][1] + EYE_SACCADE_INT_STEP
}

function randomSaccadeInterval(): number {
  const r = Math.random()
  for (let i = 0; i < EYE_SACCADE_INT_P.length; i++) {
    if (r <= EYE_SACCADE_INT_P[i][0]) {
      return EYE_SACCADE_INT_P[i][1] + Math.random() * EYE_SACCADE_INT_STEP
    }
  }
  return EYE_SACCADE_INT_P[EYE_SACCADE_INT_P.length - 1][1] + Math.random() * EYE_SACCADE_INT_STEP
}

class EyeSaccadeController {
  private nextSaccadeAfter = -1
  private timeSinceLastSaccade = 0
  private fixationTarget = new THREE.Vector3()

  instantUpdate(vrm: VRM, target: { x: number; y: number; z: number }) {
    this.fixationTarget.set(target.x, target.y, target.z)
    if (!vrm.lookAt) return
    if (!vrm.lookAt.target) {
      vrm.lookAt.target = new THREE.Object3D()
    }
    vrm.lookAt.target.position.copy(this.fixationTarget)
    vrm.lookAt.update(0.016)
  }

  update(vrm: VRM, lookAtTarget: { x: number; y: number; z: number }, delta: number) {
    if (!vrm.expressionManager || !vrm.lookAt) return

    if (this.timeSinceLastSaccade >= this.nextSaccadeAfter) {
      this.fixationTarget.set(
        lookAtTarget.x + THREE.MathUtils.randFloat(-0.25, 0.25),
        lookAtTarget.y + THREE.MathUtils.randFloat(-0.25, 0.25),
        lookAtTarget.z,
      )
      this.timeSinceLastSaccade = 0
      this.nextSaccadeAfter = randomSaccadeInterval() / 1000
    }

    if (!vrm.lookAt.target) {
      vrm.lookAt.target = new THREE.Object3D()
    }
    vrm.lookAt.target.position.lerp(this.fixationTarget, 1)
    vrm.lookAt.update(delta)

    this.timeSinceLastSaccade += delta
  }
}
