// Who hosts this site? IP → network owner, nameservers, platform fingerprints.
import dns from 'node:dns/promises';
import { registrableDomain } from './activity.mjs';

const PROVIDERS = [
  [/hostinger/i, 'Hostinger'], [/godaddy|wild west|secureserver/i, 'GoDaddy'], [/unified layer|newfold|bluehost|hostgator|endurance/i, 'Bluehost/HostGator (Newfold)'],
  [/siteground/i, 'SiteGround'], [/ovh/i, 'OVH'], [/hetzner/i, 'Hetzner'], [/digitalocean/i, 'DigitalOcean'], [/linode|akamai/i, 'Akamai/Linode'],
  [/amazon|aws/i, 'Amazon AWS'], [/google/i, 'Google Cloud'], [/microsoft|azure/i, 'Microsoft Azure'], [/cloudflare/i, 'Cloudflare'],
  [/contabo/i, 'Contabo'], [/ionos|1&1|1and1/i, 'IONOS'], [/namecheap/i, 'Namecheap'], [/a2 hosting/i, 'A2 Hosting'], [/dreamhost/i, 'DreamHost'],
  [/cyta|cyprus telecom/i, 'CYTA (Cyprus)'], [/cablenet/i, 'Cablenet (Cyprus)'], [/primetel/i, 'PrimeTel (Cyprus)'], [/epic|monaco telecom/i, 'Epic (Cyprus)'],
  [/wix/i, 'Wix'], [/squarespace/i, 'Squarespace'], [/shopify/i, 'Shopify'], [/automattic/i, 'WordPress.com'], [/wp ?engine/i, 'WP Engine'],
  [/fastly/i, 'Fastly'], [/vercel/i, 'Vercel'], [/netlify/i, 'Netlify'], [/github/i, 'GitHub Pages'], [/servers\.com|leaseweb/i, 'Leaseweb'],
];
const nice = (s) => (PROVIDERS.find(([re]) => re.test(s || '')) || [, null])[1];

function platformFrom(headers, html) {
  const h = (k) => headers[k] || '';
  const l = html.slice(0, 300000).toLowerCase();
  if (/wix\.com|wixstatic/.test(l) || h('x-wix-request-id')) return 'Wix';
  if (/squarespace/.test(l)) return 'Squarespace';
  if (/cdn\.shopify\.com/.test(l) || h('x-shopid')) return 'Shopify';
  if (/webflow/.test(l)) return 'Webflow';
  if (/img1\.wsimg\.com|godaddy website builder/.test(l)) return 'GoDaddy Website Builder';
  if (/jimdo/.test(l)) return 'Jimdo';
  if (h('x-kinsta-cache')) return 'Kinsta';
  if (/wpe|wpengine/i.test(h('x-powered-by')) || h('wpe-backend')) return 'WP Engine';
  if (h('x-sg-cache') || /siteground/i.test(h('host-header'))) return 'SiteGround';
  if (/hcdn/i.test(h('server')) || h('x-hcdn-request-id') || /hostinger/i.test(h('platform'))) return 'Hostinger';
  return null;
}

async function ipinfo(ip) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://ipinfo.io/${ip}/json`, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

export async function hosting(r, headers, html) {
  const out = {};
  try { out.ip = (await dns.lookup(r.host, { family: 4 })).address; } catch {}
  try { out.ns = (await dns.resolveNs(registrableDomain(r.host))).map(s => s.toLowerCase()).sort(); } catch { out.ns = []; }
  const info = out.ip ? await ipinfo(out.ip) : null;
  out.org = info?.org?.replace(/^AS\d+\s*/, '') || null;
  out.country = info?.country || null;
  out.platform = platformFrom(headers, html);
  out.behindCloudflare = /cloudflare/i.test(headers['server'] || '') || /cloudflare/i.test(out.org || '');
  const nsProvider = nice(out.ns.join(' ')) || (out.ns.some(n => /dns-parking|hostinger/.test(n)) ? 'Hostinger' : null);
  // Best guess for the real host
  out.provider = out.platform || (!out.behindCloudflare && nice(out.org)) || (out.behindCloudflare ? null : out.org) || null;
  out.dnsProvider = nsProvider;
  out.label = out.provider
    ? out.provider + (out.behindCloudflare ? ' (via Cloudflare)' : '')
    : out.behindCloudflare ? `hidden behind Cloudflare${nsProvider && nsProvider !== 'Cloudflare' ? ` · DNS at ${nsProvider}` : ''}` : 'unknown';
  return out;
}
