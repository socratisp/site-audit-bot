// Formatting audit results for Telegram (HTML parse mode) and CSV.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const grade = (s) => (s >= 80 ? '🟢' : s >= 55 ? '🟡' : s >= 30 ? '🟠' : '🔴');
const sevIcon = { 3: '🔴', 2: '🟠', 1: '🟡' };

export function formatSingle(r) {
  if (r.blocked) return `⚪ <b>${esc(r.host)}</b> | not audited\n\n🛡 ${esc(r.fatal)}\n\n<i>Sites behind ${esc(r.waf)} usually have someone technical managing them, so they're often a weaker prospect.</i>`;
  if (r.fatal && !r.issues) return `❌ <b>${esc(r.url)}</b>\n${esc(r.fatal)}`;
  const L = [];
  L.push(`${grade(r.score)} <b>${esc(r.host)}</b> | <b>${r.score}/100</b>`);
  if (r.title) L.push(`<i>${esc(r.title)}</i>`);
  if (r.fatal) { L.push('', `❌ ${esc(r.fatal)}`); }
  else {
    L.push('');
    const m = r.psi?.mobile, d = r.psi?.desktop;
    if (m && !m.error) L.push(`📱 Mobile: perf <b>${m.performance}</b> · SEO ${m.seo} · a11y ${m.accessibility} · LCP ${m.lcp}s`);
    else if (m?.error) L.push(`📱 Mobile: <i>${esc(m.error)}</i>`);
    if (d && !d.error) L.push(`🖥 Desktop: perf <b>${d.performance}</b> · LCP ${d.lcp}s`);
    L.push(`⚡ Server response: ${r.ttfb} ms`);
    L.push(`🔒 SSL: ${r.ssl?.ok ? `OK (${r.ssl.days} days left)` : `❌ ${esc(r.ssl?.error || 'invalid')}`}${r.httpRedirect?.redirects === false ? ' · ⚠️ no http→https' : ''}`);
    L.push(`🧩 ${esc(r.cms)}${r.phpVersion ? ` · PHP ${esc(r.phpVersion)}` : ''}${r.server ? ` · ${esc(r.server.slice(0, 30))}` : ''}`);
    L.push(`🍪 Cookie banner: ${r.cmp ? `yes (${esc(r.cmp)})` : 'not detected'}${r.trackers?.length ? ` · trackers: ${esc(r.trackers.join(', '))}` : ''}`);
    if (r.links) L.push(`🔗 Links: ${r.links.broken.length} broken of ${r.links.checked} checked`);
  }
  if (r.issues?.length) {
    L.push('', '<b>Problems:</b>');
    for (const i of r.issues.slice(0, 8)) L.push(`${sevIcon[i.sev]} ${esc(i.text)}`);
    if (r.issues.length > 8) L.push(`…and ${r.issues.length - 8} more`);
  } else L.push('', '✅ No significant problems. Not a good prospect.');
  if (r.links?.broken?.length) {
    L.push('', '<b>Broken links:</b>');
    for (const b of r.links.broken.slice(0, 5)) L.push(`• ${esc(b.status)}: ${esc(b.link.slice(0, 80))}`);
  }
  if (r.pitch) L.push('', '<b>💬 Opening line:</b>', `<code>${esc(r.pitch)}</code>`);
  return L.join('\n');
}

export function formatBatch(results) {
  const key = (r) => (r.blocked ? 1000 : r.score ?? 0);
  const sorted = [...results].sort((a, b) => key(a) - key(b));
  const L = [`📊 <b>Batch done: ${results.length} sites, worst first</b>`, ''];
  sorted.slice(0, 30).forEach((r, idx) => {
    if (r.blocked) { L.push(`${idx + 1}. ⚪ <b>n/a</b> · ${esc(r.host)}\n    blocked by ${esc(r.waf)}, check by hand`); return; }
    const top = r.fatal && !r.issues?.length ? r.fatal : (r.issues?.[0]?.text || 'no issues');
    L.push(`${idx + 1}. ${grade(r.score ?? 0)} <b>${r.score ?? 0}</b> · ${esc(r.host || r.url)}\n    ${esc(top)}`);
  });
  if (sorted.length > 30) L.push('', `…${sorted.length - 30} more in the CSV.`);
  L.push('', 'Send <code>/audit domain</code> for the full report on any of them.');
  return { text: L.join('\n'), sorted };
}

export function toCsv(sorted) {
  const cols = ['rank', 'score', 'url', 'title', 'mobile_perf', 'mobile_lcp_s', 'seo', 'ttfb_ms', 'ssl_ok', 'ssl_days', 'cms', 'php', 'cookie_banner', 'trackers', 'broken_links', 'top_issues', 'pitch'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = sorted.map((r, i) => {
    const m = r.psi?.mobile || {};
    return [i + 1, r.blocked ? 'blocked' : (r.score ?? 0), r.url, r.title, m.performance, m.lcp, m.seo, r.ttfb, r.ssl?.ok, r.ssl?.days, r.cms, r.phpVersion,
      r.cmp || (r.fatal ? '' : 'none'), (r.trackers || []).join(' / '), r.links?.broken?.length,
      r.fatal || (r.issues || []).slice(0, 3).map(i => i.text).join(' | '), r.pitch].map(q).join(',');
  });
  return '﻿' + cols.join(',') + '\n' + rows.join('\n') + '\n';
}
