/* The one way the browser tools start Chromium and reach the game.

   Needs `npm i --no-save playwright` and a Playwright Chromium in ~/Library/Caches/ms-playwright,
   or $EXE pointing at a Chrome. Launched headless on the real GPU (ANGLE/Metal): the game needs
   WebGL 2, and SwiftShader would measure a different renderer. */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

export function findChrome() {
  if (process.env.EXE) return process.env.EXE;
  const cache = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const p = `${cache}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function launch() {
  return chromium.launch({ headless: true, executablePath: findChrome(),
    args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
}

/* Load the game on `port` and wait until window.game exists. */
export async function openGame(page, port, query = '') {
  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.game, null, { timeout: 20000 });
}
