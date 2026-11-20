// Lead finder: Google Places API (New) Text Search → businesses with/without websites.
import fs from 'node:fs';
import path from 'node:path';

const KEY = () => process.env.PLACES_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || './data';
const USAGE_FILE = path.join(DATA_DIR, 'places-usage.json');
const SEEN_FILE = path.join(DATA_DIR, 'seen-places.json');
export const MONTHLY_CAP = +(process.env.PLACES_MONTHLY_CAP || 900); // free tier is ~1,000 Enterprise requests/month

const FIELDS = ['places.id', 'places.displayName', 'places.websiteUri', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.internationalPhoneNumber', 'places.rating', 'places.userRatingCount', 'places.businessStatus', 'places.googleMapsUri',
  'places.primaryTypeDisplayName', 'nextPageToken'].join(',');

// Links that are not a real website (a "no website" prospect)
const NOT_A_SITE = /(facebook|fb|instagram|linktr\.ee|booking|tripadvisor|wolt|foody|bolt|tiktok|google\.com|business\.site|wa\.me|linkedin)\./i;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };

export function usage() {
  const month = new Date().toISOString().slice(0, 7);
  const u = readJson(USAGE_FILE, {});
  return { month, used: u.month === month ? u.used : 0 };
}
function addUsage(n) { const u = usage(); writeJson(USAGE_FILE, { month: u.month, used: u.used + n }); }

export function markSeen(ids) {
  const s = readJson(SEEN_FILE, {}); const now = Date.now();
  for (const id of ids) s[id] = now;
  for (const [k, t] of Object.entries(s)) if (now - t > 180 * 86400000) delete s[k];
  writeJson(SEEN_FILE, s);
}
function seenRecently(id, days = 30) { const t = readJson(SEEN_FILE, {})[id]; return t && Date.now() - t < days * 86400000; }

export async function findPlaces(query, { maxPages = 3, includeSeen = false } = {}) {
  if (!KEY()) throw new Error('PLACES_API_KEY is not set on the server.');
  const u = usage();
  if (u.used + 1 > MONTHLY_CAP) throw new Error(`Monthly safety cap reached (${u.used}/${MONTHLY_CAP} requests). Resets on the 1st.`);
  const places = [];
  let pageToken, requests = 0;
  for (let p = 0; p < maxPages; p++) {
    if (usage().used + 1 > MONTHLY_CAP) break;
    const body = { textQuery: query, pageSize: 20, regionCode: 'CY', languageCode: 'en', ...(pageToken ? { pageToken } : {}) };
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body),
    });
    requests++; addUsage(1);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message?.slice(0, 200) || `Places API HTTP ${res.status}`);
    places.push(...(j.places || []));
    pageToken = j.nextPageToken;
    if (!pageToken) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  const all = places.filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY').map(p => ({
    id: p.id,
    name: p.displayName?.text || '?',
    type: p.primaryTypeDisplayName?.text || '',
    address: p.formattedAddress || '',
    phone: p.internationalPhoneNumber || p.nationalPhoneNumber || '',
    rating: p.rating ?? '',
    reviews: p.userRatingCount ?? 0,
    maps: p.googleMapsUri || '',
    status: p.businessStatus === 'CLOSED_TEMPORARILY' ? 'temporarily closed' : '',
    website: p.websiteUri || '',
  }));
  const fresh = includeSeen ? all : all.filter(p => !seenRecently(p.id));
  const withSite = [], noSite = [];
  const seenHosts = new Set();
  for (const p of fresh) {
    let host = null;
    try { host = p.website ? new URL(p.website).hostname.replace(/^www\./, '') : null; } catch {}
    if (!host || NOT_A_SITE.test(host + '.')) { noSite.push({ ...p, socialOnly: host || '' }); continue; }
    if (seenHosts.has(host)) continue; // chains sharing one site
    seenHosts.add(host);
    withSite.push(p);
  }
  return { total: all.length, skippedSeen: all.length - fresh.length, withSite, noSite, requests };
}
