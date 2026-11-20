// Website audit: fast HTTP/HTML checks + Google PageSpeed Insights.
import tls from 'node:tls';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36 SiteAuditBot/1.0';
const PSI_KEY = process.env.PSI_API_KEY || '';

const CMP_PATTERNS = [
  'cookiebot', 'onetrust', 'cookielaw', 'complianz', 'cookieyes', 'cookie-law-info', 'iubenda',
  'termly', 'usercentrics', 'borlabs', 'quantcast', 'didomi', 'cookie-notice', 'cookie-consent',
  'cookieconsent', 'consentmanager', 'klaro', 'osano', 'cookiehub', 'gdpr-cookie', 'moove_gdpr',
  'real-cookie-banner', 'consent-dock', 'cmplz', 'axeptio', 'tarteaucitron'
];
const TRACKER_PATTERNS = [
  ['googletagmanager.com', 'Google Tag Manager/Analytics'],
  ['google-analytics.com', 'Google Analytics'],
  ['connect.facebook.net', 'Meta Pixel'],
  ['hotjar.com', 'Hotjar'],
  ['clarity.ms', 'Microsoft Clarity'],
  ['tiktok.com/i18n/pixel', 'TikTok Pixel'],
];

export function normalizeUrl(input) {
  let s = String(input || '').trim().replace(/[),.;]+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) return null;
    return u.origin + (u.pathname === '/' ? '/' : u.pathname);
  } catch { return null; }
}

export function extractUrls(text) {
  const re = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,;"'<>]*)?)/gi;
  const out = new Set();
  for (const m of String(text).matchAll(re)) {
    if (/@/.test(text.slice(Math.max(0, m.index - 1), m.index))) continue; // skip emails
    const n = normalizeUrl(m[1]);
    if (n) out.add(n);
  }
  return [...out];
}

async function timedFetch(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...(opts.headers || {}) }, signal: ctrl.signal, ...opts });
    const ttfb = Math.round(performance.now() - start);
    return { res, ttfb };
  } finally { clearTimeout(t); }
}

function checkCert(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = sock.getPeerCertificate();
      const authorized = sock.authorized;
      const err = sock.authorizationError ? String(sock.authorizationError) : null;
      sock.end();
      if (!cert || !cert.valid_to) return resolve({ ok: false, error: 'no certificate' });
      const days = Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000);
      resolve({ ok: authorized && days > 0, days, issuer: cert.issuer?.O || cert.issuer?.CN || '', error: err });
    });
    sock.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function checkHttpRedirect(host) {
  try {
    const { res } = await timedFetch(`http://${host}/`, { redirect: 'manual' }, 10000);
    const loc = res.headers.get('location') || '';
    return { redirects: res.status >= 300 && res.status < 400 && loc.startsWith('https://'), status: res.status };
  } catch (e) { return { redirects: null, error: e.code || e.name }; }
}

async function psi(url, strategy) {
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  for (const c of ['performance', 'accessibility', 'seo', 'best-practices']) api.searchParams.append('category', c);
  if (PSI_KEY) api.searchParams.set('key', PSI_KEY);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { res } = await timedFetch(api.toString(), {}, 90000);
      if (res.status === 429) { if (!PSI_KEY) return { error: 'PSI rate-limited (add PSI_API_KEY)' }; await new Promise(r => setTimeout(r, 15000 * (attempt + 1))); continue; }
      const j = await res.json();
      if (j.error) return { error: j.error.message?.slice(0, 120) || 'PSI error' };
      const cats = j.lighthouseResult?.categories || {};
      const a = j.lighthouseResult?.audits || {};
      const sc = (k) => (cats[k]?.score != null ? Math.round(cats[k].score * 100) : null);
      return {
        performance: sc('performance'), accessibility: sc('accessibility'), seo: sc('seo'), bestPractices: sc('best-practices'),
        lcp: a['largest-contentful-paint']?.numericValue ? +(a['largest-contentful-paint'].numericValue / 1000).toFixed(1) : null,
        cls: a['cumulative-layout-shift']?.numericValue != null ? +a['cumulative-layout-shift'].numericValue.toFixed(2) : null,
        tbt: a['total-blocking-time']?.numericValue != null ? Math.round(a['total-blocking-time'].numericValue) : null,
        pageWeightKb: a['total-byte-weight']?.numericValue ? Math.round(a['total-byte-weight'].numericValue / 1024) : null,
      };
    } catch (e) { if (attempt === 2) return { error: e.name === 'AbortError' ? 'PSI timeout' : (e.message || 'PSI failed') }; }
  }
  return { error: 'PSI rate-limited (add PSI_API_KEY)' };
}

async function checkLinks(links, limit = 25) {
  const broken = [];
  const list = links.slice(0, limit);
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const link = list[i++];
      try {
        let { res } = await timedFetch(link, { method: 'HEAD', redirect: 'follow' }, 10000);
        if (res.status === 405 || res.status === 403 || res.status === 501) ({ res } = await timedFetch(link, { method: 'GET', redirect: 'follow' }, 10000));
        if (res.status >= 400 && res.status !== 429 && res.status !== 999) broken.push({ link, status: res.status });
      } catch (e) { broken.push({ link, status: e.name === 'AbortError' ? 'timeout' : 'error' }); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { checked: list.length, broken };
}

// options: { psiStrategies: ['mobile','desktop'], links: true }
export async function auditSite(rawUrl, options = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { url: rawUrl, fatal: 'Invalid URL' };
  const host = new URL(url).hostname;
  const strategies = options.psiStrategies || ['mobile', 'desktop'];
  const r = { url, host, checkedAt: new Date().toISOString() };

  const psiPromises = Object.fromEntries(strategies.map(s => [s, psi(url, s)]));

  // Main page fetch (try https, fall back to http)
  let page;
  try {
    page = await timedFetch(url, { redirect: 'follow' }, 20000);
  } catch (e) {
    try { page = await timedFetch(url.replace('https://', 'http://'), { redirect: 'follow' }, 20000); }
    catch (e2) {
      r.fatal = `Site unreachable (${e2.cause?.code || e2.code || e2.name})`;
      r.score = 0; r.issues = [{ sev: 3, text: 'Website does not load at all', pitch: `I tried to open ${host} and it doesn't load. Customers searching for you are hitting a dead end.` }];
      return r;
    }
  }
  const { res, ttfb } = page;
  r.status = res.status;
  r.finalUrl = res.url;
  r.ttfb = ttfb;
  const headers = Object.fromEntries(res.headers);
  r.server = headers['server'] || '';
  r.poweredBy = headers['x-powered-by'] || '';
  const html = res.status < 500 ? (await res.text()).slice(0, 3_000_000) : '';
  r.htmlKb = Math.round(html.length / 1024);

  const $ = cheerio.load(html);
  r.title = $('title').first().text().trim().slice(0, 120);
  r.metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  r.viewport = !!$('meta[name="viewport"]').length;
  r.favicon = !!$('link[rel*="icon"]').length;
  r.lang = $('html').attr('lang') || '';
  r.h1Count = $('h1').length;
  r.ogImage = !!$('meta[property="og:image"]').length;
  r.imgNoAlt = $('img').filter((_, el) => !($(el).attr('alt') || '').trim()).length;
  r.imgTotal = $('img').length;
  const generator = $('meta[name="generator"]').map((_, el) => $(el).attr('content')).get().join(' | ');
  const lower = html.toLowerCase();
  const wp = /wp-content|wp-includes/.test(lower);
  const wpVer = (generator.match(/WordPress\s*([\d.]+)/i) || lower.match(/ver=(\d+\.\d+(?:\.\d+)?)[^"']*wp-includes|wp-includes[^"']*ver=(\d+\.\d+(?:\.\d+)?)/) || [])[1] || null;
  r.cms = wp ? `WordPress${wpVer ? ' ' + wpVer : ''}` : (/wix\.com|wixstatic/.test(lower) ? 'Wix' : /squarespace/.test(lower) ? 'Squarespace' : /cdn\.shopify|shopify\.com/.test(lower) ? 'Shopify' : /joomla/.test(generator.toLowerCase()) ? 'Joomla' : generator || 'Unknown');
  r.wpVersion = wpVer;
  r.phpVersion = (r.poweredBy.match(/PHP\/([\d.]+)/i) || [])[1] || null;
  r.cmp = CMP_PATTERNS.find(p => lower.includes(p)) || null;
  r.trackers = TRACKER_PATTERNS.filter(([p]) => lower.includes(p)).map(([, n]) => n);
  const year = new Date().getFullYear();
  const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map(m => +m[1]).filter(y => y > 1995 && y <= year);
  r.copyrightYear = years.length ? Math.max(...years) : null;

  // Links
  const base = r.finalUrl || url;
  const links = new Set();
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href');
    if (!h || /^(#|mailto:|tel:|javascript:|whatsapp:|viber:)/i.test(h) || h.includes('/cdn-cgi/')) return;
    try { const u = new URL(h, base); if (/^https?:$/.test(u.protocol)) { u.hash = ''; links.add(u.toString()); } } catch {}
  });

  const [cert, httpRedirect, linkRes] = await Promise.all([
    checkCert(new URL(base).hostname),
    checkHttpRedirect(host),
    options.links === false ? Promise.resolve(null) : checkLinks([...links]),
  ]);
  r.ssl = cert; r.httpRedirect = httpRedirect; r.links = linkRes;
  if (!r.favicon) {
    try { const { res: f } = await timedFetch(new URL('/favicon.ico', base).toString(), { method: 'HEAD' }, 8000); r.favicon = f.ok; } catch {}
  }
  r.psi = {};
  for (const s of strategies) r.psi[s] = await psiPromises[s];

  scoreIt(r);
  return r;
}

function scoreIt(r) {
  const issues = [];
  const add = (sev, pts, text, pitch) => issues.push({ sev, pts, text, pitch });
  const m = r.psi?.mobile;

  if (r.status >= 400) add(3, 40, `Homepage returns HTTP ${r.status}`, `Your homepage at ${r.host} shows an error (${r.status}) instead of your site.`);
  if (!r.ssl?.ok) add(3, 25, `SSL problem: ${r.ssl?.error || 'invalid/expired'}`, `Browsers show "Not secure" on ${r.host}, which scares visitors away before they see anything.`);
  else if (r.ssl.days < 14) add(2, 10, `SSL certificate expires in ${r.ssl.days} days`, `Your SSL certificate expires in ${r.ssl.days} days. After that, browsers will block visitors with a security warning.`);
  if (r.httpRedirect?.redirects === false) add(2, 8, 'HTTP does not redirect to HTTPS', `Typing ${r.host} without https opens an insecure version of the site.`);
  if (m && !m.error) {
    if (m.performance < 30) add(3, 25, `Mobile speed score ${m.performance}/100 (LCP ${m.lcp}s)`, `On a phone, ${r.host} takes about ${m.lcp}s to show its main content. Most visitors leave after 3 seconds.`);
    else if (m.performance < 50) add(2, 15, `Mobile speed score ${m.performance}/100 (LCP ${m.lcp}s)`, `On mobile, ${r.host} takes ${m.lcp}s to load. That's slow enough to lose customers and Google ranking.`);
    else if (m.performance < 75) add(1, 6, `Mobile speed score ${m.performance}/100`, null);
    if (m.seo != null && m.seo < 80) add(2, 8, `Google SEO score ${m.seo}/100`, `Google's own SEO check gives ${r.host} ${m.seo}/100, so you're leaving search traffic on the table.`);
    if (m.accessibility != null && m.accessibility < 70) add(1, 4, `Accessibility score ${m.accessibility}/100`, null);
    if (m.pageWeightKb > 5000) add(2, 6, `Homepage weighs ${(m.pageWeightKb / 1024).toFixed(1)} MB`, `Your homepage is ${(m.pageWeightKb / 1024).toFixed(1)} MB, heavy on mobile data and slow on 4G.`);
  }
  if (r.ttfb > 1500) add(2, 8, `Slow server response (${r.ttfb} ms)`, `Your server takes ${(r.ttfb / 1000).toFixed(1)}s just to start responding, which usually means cheap or overloaded hosting.`);
  else if (r.ttfb > 800) add(1, 4, `Server response ${r.ttfb} ms`, null);
  if (!r.viewport) add(3, 15, 'Not mobile-friendly (no viewport tag)', `${r.host} isn't built for phones. Visitors have to pinch and zoom to read it.`);
  if (!r.title) add(2, 8, 'Missing page title', `Your homepage has no title, so Google has nothing to show for you in search results.`);
  if (!r.metaDescription) add(1, 5, 'Missing meta description', `Google shows random text from your page instead of a proper description of your business.`);
  if (r.h1Count === 0) add(1, 3, 'No H1 heading', null);
  if (!r.favicon) add(1, 2, 'No favicon', null);
  if (r.imgTotal > 3 && r.imgNoAlt / r.imgTotal > 0.5) add(1, 3, `${r.imgNoAlt}/${r.imgTotal} images missing alt text`, null);
  if (r.links?.broken?.length) add(2, Math.min(12, r.links.broken.length * 3), `${r.links.broken.length} broken link(s) on homepage`, `There are ${r.links.broken.length} broken link(s) on your homepage. Visitors click and get an error page.`);
  if (r.trackers?.length && !r.cmp) add(2, 8, `Tracking (${r.trackers.join(', ')}) with no cookie banner`, `Your site loads ${r.trackers[0]} without a cookie consent banner, which is a GDPR problem in the EU.`);
  if (r.wpVersion && parseFloat(r.wpVersion) < 6.4) add(2, 8, `Outdated WordPress ${r.wpVersion}`, `Your site runs an old WordPress version (${r.wpVersion}). Outdated WordPress is the #1 way sites get hacked.`);
  if (r.phpVersion && parseFloat(r.phpVersion) < 8.1) add(2, 6, `Outdated PHP ${r.phpVersion} exposed`, `Your server runs PHP ${r.phpVersion}, which no longer gets security updates.`);
  if (r.copyrightYear && r.copyrightYear < new Date().getFullYear() - 2) add(1, 3, `Footer says © ${r.copyrightYear}`, `The footer still says © ${r.copyrightYear}, which makes the business look inactive.`);

  issues.sort((a, b) => b.sev - a.sev || b.pts - a.pts);
  r.issues = issues;
  r.score = Math.max(0, 100 - issues.reduce((s, i) => s + i.pts, 0));
  r.pitch = issues.find(i => i.pitch)?.pitch || null;
}
