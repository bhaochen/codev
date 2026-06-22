# 前端 3D 渲染

本文档描述 Friend VRM 桌面伴侣的前端 3D 渲染系统。

---

## 技术栈

| 技术 | 用途 |
|------|------|
| **Three.js** | 3D 渲染引擎 |
| **@pixiv/three-vrm** | VRM 模型加载与控制 |
| **@pixiv/three-vrm-animation** | VRM 动画加载与 LookAt |
| **@pixiv/three-vrm-animation** | VRMA 动画支持 |
| **Tauri (WebKitGTK)** | 桌面窗口外壳 |
| **React** | UI 框架 |
| **Vite** | 前端构建工具 |
| **Bun** | 构建运行环境 |
| **CSS-in-JS** (内联 style) | 组件样式 |
| **Lucide React** | 图标库 |
| **marked** | Markdown 渲染 |
| **wlipsync** | WebAudio 唇形同步 |
| **Intl.Segmenter** | Unicode 字符分割 |

---

## VRMScene.tsx — 核心 3D 场景

**文件**: `src/components/friend/frontend/components/VRMScene.tsx` (~871 行)

### 组件接口

通过 `forwardRef` 暴露的操作句柄：

```typescript
interface VRMSceneHandle {
  setEmotion(emotion: string, intensity?: number): void
  setEmotionWithReset(emotion: string, durationMs: number, intensity?: number): void
  resetCamera(): void
  setTrackingMode(mode: 'mouse' | 'camera'): void
  playAction(name: string, hold?: boolean): void
  captureScreenshot(): string | null
  panCamera(dx: number, dy: number): void
  rotateCamera(dx: number, dy: number): void
  playDance(nameOrPreset: string | DancePreset): void
  stopDance(): void
  isDancing(): boolean
  setBgmVolume(v: number): void
  reset(): void
}
```

### 场景初始化

```typescript
// VRMScene 组件创建时
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,              // 透明背景
  antialias: true,          // 抗锯齿
  preserveDrawingBuffer: true,  // 截图支持
})
renderer.setClearColor(0x000000, 0)  // 完全透明

// 透视相机
const FOV = 40
const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 100)
// 轨道控制: 围绕 pivot 点的球面坐标

// 光照
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2)  // 主光
const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)         // 补光
```

### 模型加载

```typescript
loader.load(modelPath, async (gltf) => {
  // 1. 获取 VRM 数据
  const loadedVrm = gltf.userData.vrm

  // 2. 优化: 移除冗余顶点 + 合并骨架
  VRMUtils.removeUnnecessaryVertices(loadedVrm.scene)
  VRMUtils.combineSkeletons(loadedVrm.scene)

  // 3. 添加 LookAt 四元数代理
  const lookAtQuatProxy = new VRMLookAtQuaternionProxy(loadedVrm.lookAt)
  loadedVrm.scene.add(lookAtQuatProxy)

  // 4. 标准化 VRM 0.x → 1.0 姿态
  VRMUtils.rotateVRM0(loadedVrm)

  // 5. 计算自动相机位置 (根据模型包围盒)
  const box = new THREE.Box3().setFromObject(loadedVrm.scene)
  // pivot 在颈部高度
  // orbitRadius = modelSize.y / 4.2 / tan(FOV/2)

  // 6. 初始化控制器
  emote = new EmoteController(loadedVrm)
  motion = new MotionController(loadedVrm)
  handPoseCache = buildHandPoseCache(loadedVrm)

  // 7. 加载空闲动画
  motion.loadIdle('/friend/idle_loop.vrma')
})
```

### 每帧更新循环 (11 步)

```typescript
function animate() {
  // 1. Animation Mixer (MotionController)
  motion.update(delta)

  // 2. 放松手部姿态 (非舞蹈时)
  if (handPose && !motion.isDancing)
    applyRelaxedHandPose(handPose, elapsedTime)

  // 3. Humanoid 骨骼更新
  vrm.humanoid.update()

  // 4. Camera tracking mode → lookAt
  if (trackingMode === 'camera')
    saccades.instantUpdate(vrm, camera.position)

  // 5. LookAt 更新
  vrm.lookAt.update(delta)

  // 6. 眼球微动 (saccades)
  saccadesController.update(vrm, lookAtTarget, delta)

  // 7. 眨眼 (blink)
  updateBlink(vrm, delta, blinkState)

  // 8. 表情过渡 (EmoteController)
  emote.update(delta)

  // 9. 唇形同步 (LipSync)
  lipSync.update(vrm, delta)

  // 10. Expression Manager
  vrm.expressionManager.update()

  // 11. Spring Bone 物理
  vrm.springBoneManager.update(delta)

  renderer.render(scene, camera)
}
```

### 相机控制系统

球面坐标相机控制：

```typescript
// 参数: pivot(旋转中心), orbitRadius(距离), orbitTheta(水平角), orbitPhi(垂直角)
camera.position.set(
  pivot.x + radius * sin(phi) * sin(theta),
  pivot.y + radius * cos(phi),
  pivot.z + radius * sin(phi) * cos(theta),
)
camera.lookAt(pivot)
```

- 鼠标滚轮: 缩放 (0.8-5.0)
- 左键拖拽 VRM 模型: 双击触发射线碰撞检测身体区域
- 中键拖拽: 推拉 (dolly)
- 右键拖拽: 旋转视角
- 菜单栏拖拽按钮: 平移 / 旋转 视角

### 眼球追踪系统

两种模式:
- `mouse`: 鼠标在屏幕上的位置决定 VRM 视线的交点（通过射线平面求交）
- `camera`: VRM 始终看向相机位置

眼球微动控制器 (`EyeSaccadeController`):
- 每 400-1200ms 添加随机偏移 (-0.25 到 0.25 units)
- 瞬间更新 + 每帧 lerp 平滑

### 眨眼系统

- 随机间隔: 1-6s
- 眨眼时长: 150ms
- 使用 sin(π * progress) 曲线实现自然闭合
- 每帧更新 `blink` blendshape

### 放松手部姿态

当 VRM 模型没有手指动画轨道时，手指会保持 T-pose 僵硬状态。
解决方案：每帧手动设置手指旋转。

```typescript
// 手指自然弯曲 (从拇指到小指递增)
const curlMap = {
  Thumb:  [0.25, 0.15, 0.10],
  Index:  [0.20, 0.30, 0.20],
  Middle: [0.25, 0.35, 0.25],
  Ring:   [0.30, 0.40, 0.30],
  Little: [0.35, 0.45, 0.30],
}
// 手指自然张开
const spreadMap = { Thumb: 0.15, Index: 0.04, Middle: 0, Ring: -0.04, Little: -0.08 }
// 微妙颤动: sin(time * freq + seed) * 0.02
```

### 触摸区域检测

射线检测 + 最近骨骼匹配：

```typescript
const boneRegionMap: [string, TouchRegion][] = [
  ['head', 'head'], ['neck', 'head'],
  ['leftShoulder', 'arm'], /* ...所有手臂骨骼... */
  ['chest', 'chest'], ['spine', 'belly'],
  ['hips', 'buttocks'],
  ['leftUpperLeg', 'leg'], /* ...所有腿部骨骼... */
]
// 计算点击点与所有骨骼的世界坐标距离
// 选择最近的骨骼对应的区域
```

双击确认（500ms 窗口）+ 5s 冷却。

### 窗口穿透点击检测

```typescript
// 渲染到 1x1 offscreen render target
// 读取光标位置的 alpha 通道
// alpha > 10 → 点击在模型上 → 不穿透
// alpha <= 10 → 点击在透明背景 → 穿透窗口
```

---

## EmoteController — Blend Shape 动画系统

**文件**: `src/components/friend/frontend/emote.ts` (~207 行)

详细情绪映射见 [情绪 → 3D 表情映射](emotion-map.md)。

### 核心机制

```
EmoteController
  ├── emotionStates: Map<emotionName, { expression[], blendDuration }>
  │   13 种情绪的 blend shapes 组合定义
  │
  ├── setEmotion(name, intensity)
  │   开始过渡：记录起始值、设置目标值、启动过渡
  │
  ├── setEmotionWithReset(name, durationMs, intensity)
  │   设置表情 + 定时自动回中到 neutral
  │
  ├── update(deltaTime)
  │   每帧计算 cubic ease 过渡
  │
  └── resetAll()
      立即清零所有 blendshape
```

---

## MotionController — 动画系统

**文件**: `src/components/friend/frontend/motion-controller.ts` (~421 行)

### 支持的文件格式

| 格式 | 描述 | 来源 |
|------|------|------|
| VRMA | VRM Animation 格式 | 标准动画文件 |
| VMD | MikuMikuDance 格式 | 舞蹈动画 (极乐净土/恋爱循环) |
| FBX | Autodesk FBX 格式 | Mixamo 动画 (开心/生气等) |

### 动作预设

**短动作** (单次触发，完成后回归 idle):

```typescript
akimbo:      { label: '叉腰',   type: 'vrma' }
playFingers: { label: '搓手',   type: 'vrma' }
scratchHead: { label: '挠头',   type: 'vrma' }
stretch:     { label: '伸展',   type: 'vrma' }
happy:       { label: '开心',   type: 'fbx'  }
angry:       { label: '生气',   type: 'fbx'  }
greeting:    { label: '招呼',   type: 'fbx'  }
excited:     { label: '兴奋',   type: 'fbx'  }
shy:         { label: '害羞',   type: 'fbx'  }
point:       { label: '指点',   type: 'fbx'  }
salute:      { label: '敬礼',   type: 'fbx'  }
angryPump:   { label: '暴怒',   type: 'fbx'  }
```

**舞蹈** (循环播放，支持 BGM):

```typescript
jile: { label: '极乐净土', type: 'vmd', bgm: '/friend/jile.mp3' }
love: { label: '恋爱循环', type: 'vmd', bgm: '/friend/love.mp3' }
```

### 动画过渡系统

使用单个持久的 `AnimationMixer` 配合 `crossFade` 过渡，避免 T-pose 闪烁：

```typescript
private crossFadeTo(newAction, duration = 0.3s) {
  newAction.reset().setEffectiveWeight(1).play()
  const prev = this.currentAction ?? this.idleAction
  if (prev && prev !== newAction) {
    prev.crossFadeTo(newAction, duration, false)
  }
  this.currentAction = newAction
}
```

### 动作生命周期

```
playAction('happy')
    │
    ├── 检查并发锁 (_actionPlaying / _isDancing)
    │
    ├── 异步加载动画文件 (带 generation 标记)
    │   ├── VRMA: GLTFLoader + VRMAnimationLoaderPlugin
    │   ├── FBX: loadMixamoAnimation
    │   └── VMD: parseVMDAnimation + bindVMDToVRM + IK
    │
    ├── crossFadeTo(action, 0.3s)
    │
    ├── LoopOnce + clampWhenFinished
    │
    ├── finished 事件 → 回归 idle
    │   └── hold 模式: 保持 10s 后回归 idle
    │
    └── 安全性超时: (duration + 1s) 后强制释放
```

### VMD 舞蹈系统

特殊处理 VMD 格式：

```typescript
loadVMDWithIK(url)
    ├── 1. 解析 VMD 文件 (parseVMDAnimation)
    │    - 解析 VMD 二进制格式
    │    - 从 VRM 骨骼映射到关键帧
    │    - 缓存解析结果 (解析开销大)
    │
    ├── 2. 绑定到 VRM (bindVMDToVRM)
    │    - 生成 Three.js AnimationClip
    │    - 创建 IK 目标对象
    │    - 启用 IK 处理器
    │
    └── 3. 建立复用的 IK 处理器 (VRMIKHandler)
         - 使用 FABRIK 算法
         - 支持手臂 IK
         - 每帧在 mixer.update 后运行
```

舞蹈启动时自动切换相机视角到合适位置（臀部高度为中心）。

### BGM 系统

```typescript
// 舞蹈开始时
this.bgmAudio = new Audio(preset.bgm)
this.bgmAudio.loop = true
this.bgmAudio.volume = this._volume
this.bgmAudio.play()

// 舞蹈停止时: 淡出 (每隔 50ms 降低 0.1)
const fadeInterval = setInterval(() => {
  audio.volume = Math.max(0, audio.volume - 0.1)
  if (audio.volume <= 0) { clearInterval(fadeInterval); audio.pause() }
}, 50)
```

---

## LipSync — 唇形同步

**文件**: `src/components/friend/frontend/lip-sync.ts` (~187 行)

### 技术实现

使用 `wlipsync` 库的 WebAudio 音频分析节点：

```typescript
// 初始化
this.lipSyncNode = await createWLipSyncNode(audioContext, profile)
// lipSyncNode 只分析音频，不连接扬声器
// gainNode 连接扬声器

// 播放音频时，同时连接到 lipSyncNode 和 gainNode
source.connect(this.lipSyncNode)  // 分析
source.connect(this.gainNode)     // 扬声器
```

### 音素 → VRM Blend Shape 映射

| wlipsync 分析键 | VRM Blend Shape |
|----------------|----------------|
| `A` | `aa` (张嘴) |
| `E` | `ee` (露齿) |
| `I` | `ih` (微张嘴) |
| `O` | `oh` (嘟嘴) |
| `U` | `ou` (收唇) |
| `S` | 映射到 `I`/`ih` |

双胜者策略：取概率最高的两个音素，胜者 cap 0.7，亚军 cap 0.35。

### 平滑参数

- `ATTACK`: 50 (上升速率)
- `RELEASE`: 30 (衰减速率)
- `CAP`: 0.7 (最大权重)
- `SILENCE_VOL`: 0.04 (静音音量阈值)
- `SILENCE_GAIN`: 0.05 (静音增益阈值)
- `IDLE_MS`: 160 (静音判定窗口)

公式: `smoothed = from + (to - from) * (1 - exp(-rate * delta))`

静音时完全跳过 blendshape 设置（让 EmoteController 控制嘴部）。

---

## TextBubble.tsx — 文字气泡

**文件**: `src/components/friend/frontend/components/TextBubble.tsx` (~608 行)

### 核心功能

1. **SSE 驱动**：通过 `EventSource` 实时接收 `VrmBroadcastPayload`
2. **打字机效果**：逐字符显示，CJK/English 自适应速率
3. **音频队列**：多句子音频按索引顺序播放，支持 `appendText` 配对
4. **Markdown 渲染**：打字机完成后使用 `marked` 渲染
5. **发送首 TTS 队列**：支持排队 `sendFirstTts` 信号
6. **看门狗**：30s 超时自动隐藏（防止卡死）

### 打字机速率计算

```typescript
function getCharRate(text: string, ttsEnabled: boolean): number {
  const ratio = cjkRatio(text)
  if (ttsEnabled) {
    return Math.round(200 * ratio + 60 * (1 - ratio))  // CJK: 200ms, EN: 60ms
  }
  return Math.round(80 * ratio + 30 * (1 - ratio))     // CJK: 80ms, EN: 30ms
}
```

### 消息处理逻辑

```
handleMessage(msg)
    │
    ├── Audio-only: 直接入音频队列
    │
    ├── appendText: 配对文字和音频索引，等待播放时揭示文字
    │
    ├── Image-only: 显示图片，15s 自动隐藏
    │
    ├── Emotion-only: 转发 onMessage 回调 (不改变气泡)
    │
    └── Text message:
        ├── sendFirstTts: 重置音频队列，播放首句 TTS
        ├── 设置文字 → 启动打字机
        ├── 打字机完成后隐藏调度 (2s)
        └── 如果没有 TTS → 打字机完成后直接调度隐藏
```

### 隐藏调度逻辑

```
tryScheduleHide()
    ├── 打字机完成? (typewriterRef === null)
    ├── 音频播放完毕? (!audioPlaying && queue empty)
    ├── sendFirstTts 队列为空?
    ├── replyDone 已收到?
    │
    └── 全部满足 → setTimeout(hideBubble, 2000ms)
```

---

## ChatInput.tsx — 输入栏

**文件**: `src/components/friend/frontend/components/ChatInput.tsx` (~475 行)

### 三种模式

1. **文字输入模式**: 输入框 + 发送按钮 + 回车发送
2. **PTT 模式**: 按住麦克风按钮录音，松开停止并转录
3. **语音通话模式** (F2): 连续语音，VAD 自动分段

### 全局快捷键

- `Enter`: 打开输入栏 / 发送消息
- `Escape`: 关闭输入栏
- `F2`: 切换语音通话
- `F4`: 设置面板
- `F5`: 刷新前端
- `Tab`: 折叠/展开菜单
- `Ctrl+D`: 清空输入

### 语音通话 TTS 中断

```typescript
const scheduleInterrupt = useCallback(() => {
  // 1s 延迟中断 TTS 播放
  // 当用户开始说话时，延迟 1s 后中断当前 TTS
  // 避免用户的"嗯"等短暂声音打断对话
  setTimeout(() => {
    ;(window as any).__clawInterruptAudio?.()
  }, 1000)
}, [])
```

---

## MoodIndicator.tsx — 心情指示器

**文件**: `src/components/friend/frontend/components/MoodIndicator.tsx` (~373 行)

### Canvas 动画

- **液态填充柱状图**: 使用二次贝塞尔波浪动画 + Canvas clip
- **爱心图标**: 同样的波浪填充，经典心形路径
- **双波浪层**: 不同速度和透明度叠加，产生液态流动效果
- **颜色分级**: 90+ 粉色 → 70+ 橙色 → 50+ 绿色 → 30+ 蓝色 → 0+ 灰色
- **浮动气泡**: 心情变化时显示 `❤️+3` 或 `🩶-2` 浮动动画

### 交互

- 正常状态: 半透明 (opacity 0.5)
- 鼠标悬停: 全透明 (opacity 1.0)
- 拖拽: 可自由移动到任意位置
- 自动隐藏: 5s 无交互后恢复半透明

### 波浪参数

```typescript
WAVE_LENGTH = 8        // 波长
WAVE_HEIGHT = 2.5      // 波高 (px)

// 双波浪叠加
drawWave(scrollDir: -1, alpha: 0.55)  // 底层波浪，慢速反向
drawWave(scrollDir: 1, alpha: 1.0)    // 顶层波浪，快速正向
```

---

## 其他组件

### ResizeHandles
窗口大小调整手柄，支持拖拽调整窗口尺寸。

### SettingsPanel
设置面板 (F4 打开)，包含:
- VRM 模型选择/导入
- TTS 开关 + 语音选择
- 显示设置 (文字气泡、UI、心情)
- 追踪模式 (鼠标/相机)
- 音量控制
- 屏幕观察设置
- 语言设置
- STT Provider 选择
- 舞蹈选择

### HistoryPanel
对话历史面板，显示最近 100 条消息，支持拖拽移动位置。
