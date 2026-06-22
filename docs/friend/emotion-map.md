# 情绪 → 3D 表情映射

Friend 系统支持 13 种情绪，每种映射到 VRM blend shapes 组合、过渡时间和肢体动作。

---

## 完整映射表

数据来源: `src/components/friend/frontend/emote.ts`

| 情绪 | Blend Shapes 组合 | 过渡时间 | 肢体动作 |
|------|------------------|---------|---------|
| `happy` | happy(0.2) + aa(0.8) | 0.4s | `happy` (开心.fbx) |
| `sad` | sad(0.7) + oh(0.15) | 0.4s | `shy` (害羞.fbx) |
| `angry` | angry(0.7) + ee(0.3) | 0.3s | `angry` (生气.fbx) |
| `surprised` | surprised(0.8) + oh(0.4) | 0.15s | `excited` (兴奋.fbx) |
| `think` | think(0.7) | 0.5s | `scratchHead` (挠头.vrma) |
| `awkward` | sad(0.3) + ee(0.2) | 0.5s | `playFingers` (搓手.vrma) |
| `question` | surprised(0.4) + think(0.3) | 0.4s | `point` (指点.fbx) |
| `curious` | think(0.5) + surprised(0.2) | 0.4s | `scratchHead` (挠头.vrma) |
| `neutral` | neutral(1.0) | 0.6s | `salute` (敬礼.fbx) |
| `love` | happy(0.2) + relaxed(0.4) | 0.4s | `shy` (害羞.fbx) |
| `flirty` | happy(0.2) + relaxed(0.3) + aa(0.15) | 0.4s | `shy` (害羞.fbx) |
| `greeting` | happy(0.2) + aa(0.3) | 0.3s | `greeting` (招呼.fbx) |
| `relaxed` | relaxed(0.8) | 0.5s | `salute` (敬礼.fbx) |

### 使用的 VRM Blend Shapes

VRM 标准 blendshape 名称及其对应的面部区域：

| Blend Shape | 面部区域 |
|-------------|---------|
| `happy` | 嘴角上扬 (smile) |
| `sad` | 嘴角下垂 |
| `angry` | 皱眉 |
| `surprised` | 眉毛上抬 |
| `think` | 思考表情 |
| `neutral` | 自然表情 |
| `relaxed` | 放松表情 |
| `aa` | 张嘴 (A 音) |
| `ee` | 露齿 (E 音) |
| `oh` | 嘟嘴 (O 音) |
| `ih` | 微张嘴 (I 音, 主要用于唇同步) |
| `ou` | 收唇 (U 音, 主要用于唇同步) |
| `blink` | 闭眼 (由眨眼系统独立控制) |

---

## EmoteController 过渡系统

**文件**: `src/components/friend/frontend/emote.ts`

### 过渡算法

```typescript
// cubic ease 缓动函数
setEmotion('happy', intensity = 0.8)
    │
    ├── 1. 获取情绪定义
    │   happy: [{name:'happy', value:0.2}, {name:'aa', value:0.8}]
    │
    ├── 2. 乘以 intensity
    │   happy = 0.2 * 0.8 = 0.16
    │   aa    = 0.8 * 0.8 = 0.64
    │
    ├── 3. 记录当前 blendshape 值 (起始值)
    │   currentValues = { happy: 0.05, aa: 0, ... }
    │
    ├── 4. 设置目标值
    │   targetValues = { happy: 0.16, aa: 0.64 }
    │
    ├── 5. 开始过渡 (isTransitioning = true)
    │
    └── 每帧 update(deltaTime):
        │
        ├── transitionProgress += deltaTime / blendDuration(0.4s)
        │
        ├── if progress >= 1: transition end
        │
        ├── cubic ease:
        │   t < 0.5 → 4 * t³
        │   t >= 0.5 → 1 - (-2t + 2)³ / 2
        │
        └── value = start + (target - start) * ease(t)
```

### 自动回中系统

```typescript
setEmotionWithReset('happy', durationMs = 5000, intensity = 0.8)
    ├── setEmotion('happy', 0.8)         // 立即开始过渡
    └── setTimeout(5000ms)
        └── setEmotion('neutral')         // 自动回中到自然表情
```

### 完整重置

```typescript
resetAll()
    ├── 清除 resetTimer
    ├── isTransitioning = false
    ├── 将所有 blendshape 值设为 0
    └── 清空 currentValues / targetValues
```

---

## 情绪 → 动作映射

**文件**: `src/components/friend/frontend/App.tsx`

App.tsx 中的 `emotionActionMap` 定义了情绪与动作的关联：

```typescript
const emotionActionMap: Record<string, string> = {
  think:     'scratchHead',  // 挠头
  question:  'point',        // 指
  curious:   'scratchHead',  // 挠头
  happy:     'happy',        // 开心
  surprised: 'excited',      // 兴奋
  angry:     'angry',        // 生气
  awkward:   'playFingers',  // 搓手指
  sad:       'shy',          // 害羞
  love:      'shy',          // 害羞
  flirty:    'shy',          // 害羞
  greeting:  'greeting',     // 招呼
  relaxed:   'salute',       // 敬礼
  neutral:   'salute',       // 敬礼
}
```

动作文件类型：
- `.vrma`: VRM Animation 格式 (挠头、搓手、伸展、叉腰)
- `.fbx`: Mixamo FBX 格式 (开心、生气、招呼、兴奋、害羞、指点、敬礼、暴怒)

---

## 心情指数系统

除了即时表情，Friend 还有持续的心情指数系统：

```
moodIndex: 0-100
  ├── 0-29:  低 (灰色, rgb(160,168,180))
  ├── 30-49: 偏低 (蓝色, rgb(78,168,222))
  ├── 50-69: 中等 (绿色, rgb(72,199,142))
  ├── 70-89: 良好 (橙色, rgb(255,165,70))
  └── 90-100: 优秀 (粉色, rgb(255,107,157))
```

- LLM 通过 `friend_emotion` 工具的 `mood_delta` 参数调整 (-3 到 +3)
- 前端 MoodIndicator 组件以液态填充柱状图 + 爱心图标可视化
- Canvas 动画使用贝塞尔波浪动画和颜色渐变

---

## 触摸交互反应系统

**文件**: `src/components/friend/frontend/App.tsx`

6 个触摸区域各自有多个可能的反应：

| 区域 | 可能的反应 (情绪 + 动作) |
|------|------------------------|
| head (头) | relaxed+happy, relaxed+shy, angry+angryPump, relaxed+excited |
| arm (手臂) | surprised+excited, happy+happy, relaxed+greeting, relaxed+akimbo |
| chest (胸) | angry+angryPump, angry+angry, angry+point |
| belly (肚子) | angry+angryPump, angry+angry, awkward+playFingers |
| buttocks (屁股) | angry+angryPump, angry+point, sad+shy |
| leg (腿) | sad+shy, angry+angry, awkward+playFingers |

触摸交互逻辑：
1. 双击模型触发区域检测（射线检测 + 最近骨骼匹配）
2. 随机选择该区域的一个反应组合
3. 立即播放表情 + 动作
4. 3s 冷却期写入 session memo（[用户摸了摸你的xx]）
5. 60s 冷却期 + 50% 概率发送文字回复到 AI（POST /plugins/friend/touch）

---

## 空闲小动作系统

当用户 30 秒无活动时，VRM 角色会自动做一些小动作：

```
idleMs >= 30,000ms → 每 15s 检查一次
    │
    ├── 50% 概率触发
    ├── 随机选择 13 种情绪之一
    ├── 随机选择 12 种动作之一
    ├── 强度: 0.4-0.8 (随机)
    └── 持续: 3-5s (随机)
```

此系统防止角色长时间静止不动，增加生动感。
