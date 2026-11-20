// iPhone screenshots with Playwright WebKit (same engine as Safari, but Linux fonts, not Apple's).
import { webkit, devices } from 'playwright';

let browser = null, idle = null, launching = null;
async function getBrowser() {
  if (!browser) browser = await (launching ||= webkit.launch()).finally(() => { launching = null; });
  clearTimeout(idle);
  idle = setTimeout(async () => { const b = browser; browser = null; await b?.close().catch(() => {}); }, 5 * 60000);
  return browser;
}

export async function iphoneShot(url, { timeoutMs = 35000 } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 2, locale: 'en-GB' });
  const page = await ctx.newPage();
  const out = { loadMs: null, error: null };
  try {
    const t0 = Date.now();
    try { await page.goto(url, { waitUntil: 'load', timeout: timeoutMs }); out.loadMs = Date.now() - t0; }
    catch (e) { out.error = /timeout/i.test(e.message) ? `still loading after ${timeoutMs / 1000}s` : e.message.split('\n')[0].slice(0, 100); }
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, vw: window.innerWidth,
      h: Math.min(document.documentElement.scrollHeight, 9000),
      title: document.title,
    })).catch(() => null);
    if (m) { out.overflowPx = Math.max(0, m.sw - m.vw); out.pageHeight = m.h; out.title = m.title; }
    out.above = await page.screenshot({ type: 'jpeg', quality: 75 });
    const h = Math.min(out.pageHeight || 844, 7000);
    out.full = h > 900 ? await page.screenshot({ type: 'jpeg', quality: 60, fullPage: true, clip: { x: 0, y: 0, width: 390, height: h } }).catch(() => null) : null;
  } finally { await ctx.close().catch(() => {}); }
  return out;
}

export async function closeBrowser() { await browser?.close().catch(() => {}); browser = null; }
