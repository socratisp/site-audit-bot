// "How alive is this site?" signals: domain age, site build date, last edit.
const UA = 'Mozilla/5.0 SiteAuditBot/1.0';

async function getJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}
async function getText(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 2_000_000);
  } catch { return null; } finally { clearTimeout(t); }
}

export function registrableDomain(host) {
  const p = host.replace(/^www\./, '').split('.');
  if (p.length >= 3 && p.at(-1).length === 2 && /^(com|org|net|ac|gov|edu|co|ltd|biz|info|press)$/.test(p.at(-2))) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

async function domainAge(domain) {
  const j = await getJson(`https://rdap.org/domain/${domain}`, 12000);
  const ev = j?.events?.find(e => e.eventAction === 'registration');
  return ev?.eventDate ? new Date(ev.eventDate) : null;
}

async function wordpressDates(origin) {
  const f = '_fields=date,modified';
  const [pm, po, pf] = await Promise.all([
    getJson(`${origin}/wp-json/wp/v2/pages?per_page=1&orderby=modified&order=desc&${f}`),
    getJson(`${origin}/wp-json/wp/v2/posts?per_page=1&orderby=modified&order=desc&${f}`),
    getJson(`${origin}/wp-json/wp/v2/pages?per_page=1&orderby=date&order=asc&${f}`),
  ]);
  const mods = [pm?.[0]?.modified, po?.[0]?.modified].filter(Boolean).map(d => new Date(d));
  return {
    lastEdit: mods.length ? new Date(Math.max(...mods)) : null,
    built: pf?.[0]?.date ? new Date(pf[0].date) : null,
  };
}

async function sitemapLastmod(origin) {
  for (const path of ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml']) {
    let xml = await getText(origin + path);
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    let dates = [...xml.matchAll(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/gi)].map(m => new Date(m[1])).filter(d => !isNaN(d) && d <= Date.now() + 86400000);
    if (!dates.length && /<sitemapindex/i.test(xml)) {
      // WP core index has no lastmod: peek into the first child sitemap(s)
      const kids = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]).slice(0, 3);
      for (const k of kids) {
        const kx = await getText(k);
        if (kx) dates.push(...[...kx.matchAll(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/gi)].map(m => new Date(m[1])).filter(d => !isNaN(d)));
      }
    }
    if (dates.length) return new Date(Math.max(...dates));
  }
  return null;
}

export async function activity(r, html) {
  const origin = new URL(r.finalUrl || r.url).origin;
  const uploads = [...String(html).matchAll(/wp-content\/uploads\/(\d{4})\/(\d{2})\//g)].map(m => new Date(`${m[1]}-${m[2]}-01`)).filter(d => !isNaN(d));
  const isWp = /wp-content|wp-includes/.test(html);
  const [reg, wp, sm] = await Promise.all([
    domainAge(registrableDomain(r.host)),
    isWp ? wordpressDates(origin) : Promise.resolve({}),
    sitemapLastmod(origin),
  ]);
  const candidatesEdit = [wp.lastEdit, sm, uploads.length ? new Date(Math.max(...uploads)) : null].filter(Boolean);
  const candidatesBuilt = [wp.built, uploads.length ? new Date(Math.min(...uploads)) : null].filter(Boolean);
  return {
    domainSince: reg,
    built: candidatesBuilt.length ? new Date(Math.min(...candidatesBuilt)) : null,
    lastEdit: candidatesEdit.length ? new Date(Math.max(...candidatesEdit)) : null,
    lastEditSource: wp.lastEdit ? 'WordPress' : sm ? 'sitemap' : candidatesEdit.length ? 'newest upload' : null,
  };
}

export function ago(d) {
  if (!d) return '';
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days < 1) return 'today';
  if (days < 14) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')} years ago`;
}
