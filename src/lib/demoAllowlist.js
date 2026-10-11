// The free demo's allow-list, from two places.
//
// STRESSPROOF_DEMO_ALLOWLIST (comma separated) still works as before. On top
// of it, demo-allowlist.txt at the repo root lists one URL prefix per line, so
// adding an agent whose owner has agreed is an edit to a tracked file: it shows
// up in history with who added it and when, and goes live on the next deploy.
//
// Both are read once at boot, like every other setting here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALLOWLIST_FILE = fileURLToPath(new URL('../../demo-allowlist.txt', import.meta.url));

/**
 * An entry has to name a real host. A bare "https://" would be a prefix of
 * every target and quietly turn the free route into a free route at anyone.
 */
export function isUsableEntry(entry) {
  try {
    const url = new URL(entry);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function parseAllowlistFile(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function loadDemoAllowlist({ env = process.env, filePath = DEFAULT_ALLOWLIST_FILE, readFile = readFileSync } = {}) {
  const fromEnv = (env.STRESSPROOF_DEMO_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  let fromFile = [];
  try {
    fromFile = parseAllowlistFile(readFile(filePath, 'utf8'));
  } catch {
    // No file is fine: the env var alone is the old behaviour.
  }

  const kept = [];
  const rejected = [];
  for (const entry of [...fromEnv, ...fromFile]) {
    if (!isUsableEntry(entry)) rejected.push(entry);
    else if (!kept.includes(entry)) kept.push(entry);
  }
  return { allowlist: kept, rejected };
}
