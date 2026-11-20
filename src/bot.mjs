import fs from 'node:fs';
import path from 'node:path';
import { Bot, InputFile } from 'grammy';
import { auditSite, extractUrls, normalizeUrl } from './audit.mjs';
import { formatSingle, formatBatch, toCsv } from './report.mjs';
import { iphoneShot } from './shot.mjs';
import { findPlaces, markSeen, usage, MONTHLY_CAP } from './places.mjs';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('BOT_TOKEN is missing'); process.exit(1); }
const DATA_DIR = process.env.DATA_DIR || './data';
const OWNER_FILE = path.join(DATA_DIR, 'owner.json');
const MAX_BATCH = +(process.env.MAX_BATCH || 200);
const BATCH_CONCURRENCY = +(process.env.BATCH_CONCURRENCY || 2);
fs.mkdirSync(DATA_DIR, { recursive: true });

let ownerId = process.env.OWNER_ID ? +process.env.OWNER_ID : null;
if (!ownerId && fs.existsSync(OWNER_FILE)) ownerId = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')).id;

const bot = new Bot(TOKEN);
let busy = false;

// Lock: first person to /start becomes owner; everyone else is ignored.
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  if (!ownerId) {
    if (ctx.message?.text?.startsWith('/start')) {
      ownerId = uid;
      fs.writeFileSync(OWNER_FILE, JSON.stringify({ id: uid, name: ctx.from.first_name, at: new Date().toISOString() }));
      console.log('Owner claimed:', uid);
    } else return ctx.reply('Send /start to claim this bot.');
  }
  if (uid !== ownerId) return; // silently ignore strangers
  return next();
});

const HELP = `<b>Site Audit Bot</b>

• <code>/audit example.com</code> → full report + opening line + iPhone screenshots
• <code>/shot example.com</code> → iPhone screenshots only (WebKit)
• <code>/find restaurants Protaras</code> → finds up to 60 businesses on Google Maps, audits their sites (worst first), lists the ones with NO website
• <code>/findall …</code> → same, but includes places you already checked this month
• <code>/usage</code> → Google Places usage (free cap)
• Paste one link → same as /audit
• Paste many links (one per line) → batch, ranked worst first + CSV
• Upload a .csv or .txt with URLs → batch

Batch checks mobile only, no screenshots (faster). ~20–40s per site.`;

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

async function runSingle(ctx, url) {
  const msg = await ctx.reply(`🔍 Auditing ${url} … (30s–2min)`);
  const t0 = Date.now();
  const tick = setInterval(() => ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🔍 Auditing ${url} … still working (${Math.round((Date.now() - t0) / 1000)}s, waiting on Google PageSpeed)`).catch(() => {}), 30000);
  try {
    const shotPromise = iphoneShot(url).catch(e => ({ error: e.message.split('\n')[0].slice(0, 100) }));
    const r = await auditSite(url, { psiStrategies: ['mobile', 'desktop'], shotPromise });
    clearInterval(tick);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, formatSingle(r), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    await sendShots(ctx, r.host, r.shot);
  } catch (e) {
    clearInterval(tick);
    console.error(e);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Audit failed: ${e.message}`);
  }
}

async function sendShots(ctx, host, shot) {
  if (!shot?.above) return;
  const cap = `📱 ${host} on iPhone 14 (WebKit)${shot.loadMs ? ` · loaded in ${(shot.loadMs / 1000).toFixed(1)}s` : ''}`;
  await ctx.replyWithPhoto(new InputFile(shot.above, `${host}-iphone.jpg`), { caption: cap }).catch(e => console.error('photo', e.message));
  if (shot.full) await ctx.replyWithDocument(new InputFile(shot.full, `${host}-iphone-fullpage.jpg`), { caption: 'Full page (first ~7000px)' }).catch(e => console.error('doc', e.message));
}

bot.command('shot', async (ctx) => {
  const [url] = extractUrls(ctx.match || '');
  if (!url) return ctx.reply('Usage: /shot example.com');
  const msg = await ctx.reply(`📸 Opening ${url} on an iPhone 14 (WebKit)…`);
  const shot = await iphoneShot(url).catch(e => ({ error: e.message.split('\n')[0] }));
  await ctx.api.editMessageText(ctx.chat.id, msg.message_id, shot.above ? `📸 Done${shot.overflowPx > 5 ? ` · ⚠️ page is ${shot.overflowPx}px wider than the screen` : ''}` : `❌ ${shot.error}`).catch(() => {});
  await sendShots(ctx, new URL(url).hostname, shot);
});

async function runBatch(ctx, urls, meta = {}, label = 'audit') {
  if (busy) return ctx.reply('⏳ A batch is already running. Wait for it to finish.');
  urls = urls.slice(0, MAX_BATCH);
  busy = true;
  const msg = await ctx.reply(`📋 Batch of ${urls.length} sites started. Estimated ${Math.ceil(urls.length * 25 / BATCH_CONCURRENCY / 60)} min. Go do something else.`);
  const results = [];
  let done = 0, lastEdit = 0, i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      let r;
      try { r = await auditSite(u, { psiStrategies: ['mobile'], links: true }); }
      catch (e) { r = { url: u, host: u, fatal: e.message, score: 0 }; }
      r.meta = meta[u] || null;
      results.push(r);
      done++;
      if (Date.now() - lastEdit > 8000) {
        lastEdit = Date.now();
        ctx.api.editMessageText(ctx.chat.id, msg.message_id, `📋 Batch: ${done}/${urls.length} done…`).catch(() => {});
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));
    const { text, sorted } = formatBatch(results);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `📋 Batch: ${urls.length}/${urls.length} done ✅`).catch(() => {});
    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    await ctx.replyWithDocument(new InputFile(Buffer.from(toCsv(sorted), 'utf8'), `${label}-${stamp}.csv`));
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Batch error: ${e.message}`);
  } finally { busy = false; }
}

bot.command(['find', 'findall'], async (ctx) => {
  const query = (ctx.match || '').trim();
  if (!query) return ctx.reply('Usage: /find restaurants Protaras\n(/findall also includes places you already checked in the last 30 days)', { parse_mode: undefined });
  if (busy) return ctx.reply('⏳ A batch is already running. Wait for it to finish.');
  const includeSeen = ctx.message.text.startsWith('/findall');
  const msg = await ctx.reply(`🔎 Searching Google Maps for “${query}”…`);
  let found;
  try { found = await findPlaces(query, { includeSeen }); }
  catch (e) { return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message}`); }
  const { total, skippedSeen, withSite, noSite, requests } = found;
  const u = usage();
  await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
    `🔎 “${query}”: ${total} businesses found\n🌐 ${withSite.length} with a website → auditing\n🚫 ${noSite.length} with no real website\n${skippedSeen ? `♻️ ${skippedSeen} skipped (checked in last 30 days)\n` : ''}📈 Google usage this month: ${u.used}/${MONTHLY_CAP} (+${requests})`);
  markSeen([...withSite, ...noSite].map(p => p.id));
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'find';
  if (noSite.length) {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const sortedNo = [...noSite].sort((a, b) => b.reviews - a.reviews);
    const lines = sortedNo.slice(0, 25).map((p, i) => `${i + 1}. <b>${esc(p.name)}</b> · ⭐${p.rating || '-'} (${p.reviews})${p.status ? ' · ' + p.status : ''}\n    ${p.socialOnly ? `only ${esc(p.socialOnly)}` : 'no website'} · ${esc(p.phone || 'no phone')}`);
    await ctx.reply(`🚫 <b>No real website: ${noSite.length}</b> (most reviewed first: busy businesses with no site)\n\n${lines.join('\n')}${noSite.length > 25 ? `\n…${noSite.length - 25} more in the CSV` : ''}`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '\uFEFF' + ['name', 'type', 'phone', 'rating', 'reviews', 'status', 'social_link', 'address', 'google_maps'].join(',') + '\n' +
      sortedNo.map(p => [p.name, p.type, p.phone, p.rating, p.reviews, p.status, p.socialOnly, p.address, p.maps].map(q).join(',')).join('\n') + '\n';
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), `no-website-${slug}.csv`));
  }
  if (!withSite.length) return ctx.reply('No websites to audit for this search.');
  const meta = {};
  const urls = withSite.map(p => { const n = normalizeUrl(p.website); if (n) meta[n] = p; return n; }).filter(Boolean);
  return runBatch(ctx, urls, meta, `leads-${slug}`);
});

bot.command('usage', (ctx) => { const u = usage(); return ctx.reply(`📈 Google Places usage ${u.month}: ${u.used}/${MONTHLY_CAP} requests (free tier ≈1,000).`); });

bot.command('audit', async (ctx) => {
  const urls = extractUrls(ctx.match || '');
  if (!urls.length) return ctx.reply('Usage: /audit example.com');
  return urls.length === 1 ? runSingle(ctx, urls[0]) : runBatch(ctx, urls);
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (doc.file_size > 2_000_000) return ctx.reply('File too big (max 2 MB).');
  const file = await ctx.getFile();
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
  const urls = extractUrls(await res.text());
  if (!urls.length) return ctx.reply('No URLs found in that file.');
  return runBatch(ctx, urls);
});

bot.on('message:text', async (ctx) => {
  const urls = extractUrls(ctx.message.text);
  if (!urls.length) return ctx.reply('Send me a website link, or /help.');
  return urls.length === 1 ? runSingle(ctx, urls[0]) : runBatch(ctx, urls);
});

bot.catch((err) => console.error('Bot error:', err.error || err));

await bot.api.setMyCommands([
  { command: 'audit', description: 'Audit a website: /audit example.com' },
  { command: 'find', description: 'Find leads: /find restaurants Protaras' },
  { command: 'shot', description: 'iPhone screenshot: /shot example.com' },
  { command: 'usage', description: 'Google Places usage this month' },
  { command: 'help', description: 'How to use' },
]);
console.log('Site Audit Bot running. Owner:', ownerId ?? '(unclaimed; send /start)');
bot.start({ drop_pending_updates: true });
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
