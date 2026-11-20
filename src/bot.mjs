import fs from 'node:fs';
import path from 'node:path';
import { Bot, InputFile } from 'grammy';
import { auditSite, extractUrls, normalizeUrl } from './audit.mjs';
import { formatSingle, formatBatch, toCsv } from './report.mjs';

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

• <code>/audit example.com</code> → full report + opening line
• Paste one link → same as /audit
• Paste many links (one per line) → batch, ranked worst first + CSV
• Upload a .csv or .txt with URLs → batch

Batch checks mobile only (faster). ~20–40s per site.`;

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

async function runSingle(ctx, url) {
  const msg = await ctx.reply(`🔍 Auditing ${url} … (30s–2min)`);
  const t0 = Date.now();
  const tick = setInterval(() => ctx.api.editMessageText(ctx.chat.id, msg.message_id, `🔍 Auditing ${url} … still working (${Math.round((Date.now() - t0) / 1000)}s, waiting on Google PageSpeed)`).catch(() => {}), 30000);
  try {
    const r = await auditSite(url, { psiStrategies: ['mobile', 'desktop'] });
    clearInterval(tick);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, formatSingle(r), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (e) {
    clearInterval(tick);
    console.error(e);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Audit failed: ${e.message}`);
  }
}

async function runBatch(ctx, urls) {
  if (busy) return ctx.reply('⏳ A batch is already running. Wait for it to finish.');
  urls = urls.slice(0, MAX_BATCH);
  busy = true;
  const msg = await ctx.reply(`📋 Batch of ${urls.length} sites started. Estimated ${Math.ceil(urls.length * 25 / BATCH_CONCURRENCY / 60)} min. Go do something else.`);
  const results = [];
  let done = 0, lastEdit = 0, i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try { results.push(await auditSite(u, { psiStrategies: ['mobile'], links: true })); }
      catch (e) { results.push({ url: u, host: u, fatal: e.message, score: 0 }); }
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
    await ctx.replyWithDocument(new InputFile(Buffer.from(toCsv(sorted), 'utf8'), `audit-${stamp}.csv`));
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Batch error: ${e.message}`);
  } finally { busy = false; }
}

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
  { command: 'help', description: 'How to use' },
]);
console.log('Site Audit Bot running. Owner:', ownerId ?? '(unclaimed; send /start)');
bot.start({ drop_pending_updates: true });
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
