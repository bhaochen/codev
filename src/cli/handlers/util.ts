/**
 * Utility handlers
 * These handlers are used by various CLI commands
 */

import type { Root } from '../../ink.js';

export async function setupTokenHandler(root: Root): Promise<void> {
  console.error('Setup token handler not implemented');
  process.exit(1);
}

export async function doctorHandler(root: Root): Promise<void> {
  console.error('Doctor handler not implemented');
  process.exit(1);
}

export async function installHandler(target: string | undefined, options: { force?: boolean }): Promise<void> {
  console.error('Install handler not implemented');
  process.exit(1);
}