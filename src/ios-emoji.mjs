// Characters that iPhones often render as colourful emoji (when the site font lacks them
// and no U+FE0E text-presentation selector follows). Classic "why are my arrows emoji on iPhone" bug.
const RISKY = '↔↕↖↗↘↙↩↪➡⬅⬆⬇⤴⤵▶◀✔✖✂✈✉✏✒☎☑☀☁❤❣✳✴❄❇♥♦♣♠⚠';
const RE = new RegExp(`[${RISKY}](?![\\uFE0E\\uFE0F])`, 'gu');

export function iosEmojiRisk($) {
  $('script,style,noscript,svg').remove();
  const text = $('body').text();
  const hits = [...text.matchAll(RE)].map(m => m[0]);
  const chars = [...new Set(hits)];
  return { count: hits.length, chars };
}
