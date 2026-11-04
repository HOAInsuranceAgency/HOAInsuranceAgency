import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node scripts/performance-audit-compare.mjs BEFORE.json AFTER.json [REPORT.md]');
const before = JSON.parse(readFileSync(resolve(beforePath), 'utf8'));
const after = JSON.parse(readFileSync(resolve(afterPath), 'utf8'));
const number = n => n == null ? 'not observed' : Number(n).toLocaleString('en-US');
const lines = [
  '# CRM performance fixture comparison', '',
  '**These are deterministic fixture measurements, not production AWS or browser timings.** The same actual React screens/hooks use the same synthetic data and injected per-request delay in both runs. Backend service counts are reported separately.', '',
  `Before source: \`${before.revision}\`. After source: \`${after.revision}\`.`, '',
  '| Flow | Requests before → after | JSON bytes before → after | First content, virtual ms before → after | Last request, virtual ms before → after |',
  '| --- | ---: | ---: | ---: | ---: |',
];
for (const previous of before.results) {
  const current = after.results.find(row => row.flow === previous.flow && row.role === previous.role);
  if (!current) throw new Error(`Missing matching flow ${previous.flow} (${previous.role})`);
  if (previous.fixtureAccounts !== current.fixtureAccounts || previous.injectedServiceDelayMs !== current.injectedServiceDelayMs) {
    throw new Error(`Fixture settings differ for ${previous.flow}`);
  }
  lines.push(`| ${previous.flow} (${previous.role}) | ${number(previous.requests)} → ${number(current.requests)} | ${number(previous.responseBytes)} → ${number(current.responseBytes)} | ${number(previous.firstContentMs)} → ${number(current.firstContentMs)} | ${number(previous.waterfallMs)} → ${number(current.waterfallMs)} |`);
}
lines.push('', 'Initial entry starts the page and roster requests in parallel. Rows appear before the two bounded background count requests finish: the table reports all four eventual requests, while raw JSON separately records the two started before first content.', '',
  'First-page results intentionally compare the initial visible work view: the old list rendered all 300 matching rows; the paged implementation initially renders 25. Full-list traversal and complete exports appear separately. Admin warm navigation retains immediate cached content while revalidating; Producer/Staff still require fresh access before cached rows can appear. Remaining detail-tab/network counts stay unchanged because index and roster improvements occur behind the GraphQL boundary. The revised projection is assumed ready; deployment initialization uses the legacy fallback.', '',
  'See `README.md` and raw JSON for fixture size, operation counts, payload definitions and reproduction commands. Backend tests and structural benchmarks establish index use, row evaluations and removed Cognito fan-out; they do not establish production p50/p95 latency.', '');
const markdown = lines.join('\n');
if (outputPath) writeFileSync(resolve(outputPath), markdown);
else process.stdout.write(markdown);
