/**
 * Persistent preferences for Friend desktop pet (VersperClaw native).
 */
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

export interface FriendPrefs {
  enabled?: boolean;
  voice?: string;
  provider?: string;
  qwenKey?: string;
  qwenModel?: string;
  modelPath?: string;
  ttsEnabled?: boolean;
  showText?: boolean;
  hideUI?: boolean;
  tracking?: 'mouse' | 'camera';
  volume?: number;
  uiAlign?: 'left' | 'right';
  screenObserve?: boolean;
  screenObserveInterval?: number;
  language?: 'zh' | 'en';
  currentDance?: string;
  hideMood?: boolean;
}

const homeDir = process.env.HOME || process.env.USERPROFILE || '';
const VSCODE_CONFIG_DIR = path.join(homeDir, '.config', 'VersperClaw');
const PREFS_PATH = path.join(VSCODE_CONFIG_DIR, 'friend.json');

const DEFAULT_PREFS: FriendPrefs = {
  enabled: false,
  provider: 'edge',
  voice: 'zh-CN-XiaoyiNeural',
};

export function loadPrefs(): FriendPrefs {
  try {
    if (existsSync(PREFS_PATH)) {
      return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(PREFS_PATH, 'utf8')) as FriendPrefs };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(p: FriendPrefs): void {
  try {
    mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2));
  } catch { /* ignore */ }
}

export function updatePrefs(patch: Partial<FriendPrefs>): FriendPrefs {
  const prefs = loadPrefs();
  Object.assign(prefs, patch);
  savePrefs(prefs);
  return prefs;
}

// Runtime cache
let _prefs = loadPrefs();

export function getPrefs(): FriendPrefs {
  return _prefs;
}

export function setPrefs(p: FriendPrefs) {
  _prefs = p;
}
