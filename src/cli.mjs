// Local test: node src/cli.mjs example.com [--json]
import { auditSite } from './audit.mjs';
import { formatSingle } from './report.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
for (const u of args.filter(a => !a.startsWith('--'))) {
  const r = await auditSite(u);
  console.log(json ? JSON.stringify(r, null, 2) : formatSingle(r).replace(/<[^>]+>/g, ''));
  console.log('\n' + '-'.repeat(40) + '\n');
}
