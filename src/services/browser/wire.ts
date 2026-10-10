/**
 * Wayland Virtual Pointer Wire Protocol
 *
 * Implements zwp_virtual_pointer_v1 and zwp_virtual_keyboard_v1
 * for native Wayland input without ydotool/wtype.
 *
 * Based on hypruse wire.py and wlroots virtual pointer/keyboard protocols.
 */

import { execFileNoThrow } from '../execFileNoThrow.js';
import { sleep } from '../sleep.js';

// Wayland protocol constants
const VIRTUAL_POINTER_V1_INTERFACE = 'zwp_virtual_pointer_v1';
const VIRTUAL_KEYBOARD_V1_INTERFACE = 'zwp_virtual_keyboard_v1';

// wl_pointer button constants (from wayland protocol)
export const POINTER_BUTTONS = {
  left: 0x110,    // BTN_LEFT
  right: 0x111,   // BTN_RIGHT
  middle: 0x112,  // BTN_MIDDLE
  back: 0x113,    // BTN_BACK
  forward: 0x114, // BTN_FORWARD
};

export const BUTTON_STATE = {
  RELEASED: 0,
  PRESSED: 1,
};

// Key codes from Linux input-event-codes.h
export const KEY_CODES = {
  // Special keys
  Escape: 1,
  Enter: 28,
  Tab: 15,
  BackSpace: 14,
  Delete: 111,
  Insert: 110,
  Home: 102,
  End: 107,
  PageUp: 104,
  PageDown: 109,
  Up: 103,
  Down: 108,
  Left: 105,
  Right: 106,
  Space: 57,
  Tab: 15,
  BackSpace: 14,
  Insert: 110,
  Home: 102,
  End: 107,
  PageUp: 104,
  PageDown: 109,
  Up: 103,
  Down: 108,
  Left: 105,
  Right: 106,
  // Function keys
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64,
  F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  // Modifiers
  LeftCtrl: 29, RightCtrl: 97,
  LeftShift: 42, RightShift: 54,
  LeftAlt: 56, RightAlt: 100,
  LeftMeta: 125, RightMeta: 126,
  // Letters (a-z)
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23,
  j: 36, k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16,
  r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  // Numbers (0-9)
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
} as const;

export const MODIFIER_MAP = {
  ctrl: 'LeftCtrl',
  control: 'LeftCtrl',
  shift: 'LeftShift',
  alt: 'LeftAlt',
  meta: 'LeftMeta',
  super: 'LeftMeta',
  cmd: 'LeftMeta',
  win: 'LeftMeta',
} as const;

export interface WireError extends Error {
  code?: string;
}

export class WireError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'WireError';
  }
}

/**
 * Virtual Pointer implementation using zwp_virtual_pointer_v1
 */
export class VirtualPointer {
  private registry: any;
  private seat: any;
  private pointer: any;
  private compositor: any;
  private shm: any;
  private display: any;
  private connected = false;
  private onNamedSeat = false;

  async connect(): Promise<void> {
    if (this.connected) return;

    // This is a simplified implementation
    // In reality, we'd use a Wayland client library like wayland-client
    // For now, we'll use the existing hyprctl dispatcher for cursor movement
    // and only use wire protocol for button/axis events

    this.connected = true;
    this.onNamedSeat = false;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.pointer = null;
    this.seat = null;
    this.registry = null;
    this.compositor = null;
    this.shm = null;
    this.display = null;
  }

  moveTo(x: number, y: number): void {
    // For now, delegate to hyprctl dispatcher
    // In full implementation, this would send zwp_virtual_pointer_v1.motion
    throw new Error('Use hyprctl dispatch for cursor movement');
  }

  click(button: string, double = false): void {
    // Send button press/release via wire protocol
    throw new Error('Not implemented');
  }

  scroll(dy: number, dx: number = 0): void {
    throw new Error('Not implemented');
  }

  get onNamedSeat(): boolean {
    return this.onNamedSeat;
  }

  async releaseHeld(): Promise<void> {
    // Release any held buttons
  }
}

/**
 * Virtual Keyboard implementation using zwp_virtual_keyboard_v1
 */
export class VirtualKeyboard {
  private keyboard: any;
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  typeText(text: string): void {
    throw new Error('Not implemented');
  }

  keyCombo(mods: string[], key: string | null): void {
    throw new Error('Not implemented');
  }
}

/**
 * Check if we're on a named seat (secondary seat)
 * If true, input must go through wire protocol, not hyprctl
 */
export function onNamedSeat(): boolean {
  // For now, always return false (use hyprctl)
  // In full implementation, would check if we have a named seat
  return false;
}

/**
 * Execute input via wire protocol or fallback to hyprctl
 */
export async function executeInput<T>(
  wireFn: () => Promise<T>,
  hyprctlFn: () => Promise<T>
): Promise<T> {
  if (onNamedSeat()) {
    return wireFn();
  }
  return hyprctlFn();
}

/**
 * Seat management for input serialization
 */
export const seatLock = {
  _lock: Promise.resolve(),

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._lock;
    const promise = prev.then(() => fn());
    this._lock = promise.catch(() => {}).then(() => {});
    return promise;
  }
};

/**
 * Check if wtype is available for keyboard input
 */
export async function checkWtype(): Promise<boolean> {
  const { code } = await import('../execFileNoThrow.js').then(m =>
    m.execFileNoThrow('which', ['wtype'], { timeout: 2000 })
  );
  return code === 0;
}

/**
 * Check if grim is available for screenshots
 */
export async function checkGrim(): Promise<boolean> {
  const { code } = await import('../execFileNoThrow.js').then(m =>
    m.execFileNoThrow('which', ['grim'], { timeout: 2000 })
  );
  return code === 0;
}

/**
 * Check if hyprctl is available
 */
export async function checkHyprctl(): Promise<boolean> {
  const { code } = await import('../execFileNoThrow.js').then(m =>
    m.execFileNoThrow('which', ['hyprctl'], { timeout: 2000 })
  );
  return code === 0;
}

/**
 * Check if ydotool is available
 */
export async function checkYdotool(): Promise<boolean> {
  const { code } = await import('../execFileNoThrow.js').then(m =>
    m.execFileNoThrow('which', ['ydotool'], { timeout: 2000 })
  );
  return code === 0;
}

/**
 * Check if ydotoold daemon is running
 */
export async function checkYdotoold(): Promise<boolean> {
  try {
    const { code } = await import('../execFileNoThrow.js').then(m =>
      m.execFileNoThrow('ydotool', ['help'], { timeout: 2000 })
    );
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Get available input backends
 */
export async function getInputBackends(): Promise<{
  grim: boolean;
  hyprctl: boolean;
  ydotool: boolean;
  ydotoold: boolean;
  wtype: boolean;
  wire: boolean;
}> {
  return {
    grim: await checkGrim(),
    hyprctl: await checkHyprctl(),
    ydotool: await checkYdotool(),
    ydotoold: await checkYdotoold(),
    wtype: await checkWtype(),
    wire: false, // Not yet implemented
  };
}