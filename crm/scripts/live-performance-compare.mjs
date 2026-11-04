// Read-only comparison of the redacted live observer exports.
// node scripts/live-performance-compare.mjs BEFORE.json AFTER.json [REPORT.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const number = (value, digits = 1) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
const metric = (samples, name) => {
  const values = samples.map(sample => sample[name]);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`Missing or invalid live metric: ${name}`);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
};
const key = sample => JSON.stringify([sample.role, sample.flow, sample.cacheCondition, sample.sample]);
const groupKey = sample => JSON.stringify([sample.role, sample.flow, sample.cacheCondition]);
const conditionNames = {
  'first-suite-data-visit': 'First suite visit — single observation per flow',
  'same-document-return': 'Same-document returns — repeated observations',
  'warm-return-after-suite': 'Final warm return — single observation per flow',
};

function normalized(value, label) {
  const samples = Array.isArray(value) ? value : value.samples ?? value.results;
  if (!Array.isArray(samples) || !samples.length) throw new Error(`${label}: no live samples found.`);
  const unique = new Set();
  for (const sample of samples) {
    if (!sample.role || !sample.flow || !sample.cacheCondition || !Number.isSafeInteger(sample.sample)) throw new Error(`${label}: incomplete sample identity.`);
    if (sample.status !== 'complete' || sample.alertCount !== 0 || sample.requests?.some(request => request.status !== 200 || request.graphQLErrors)) throw new Error(`${label}: unsuccessful flow ${sample.flow}/${sample.sample}; do not silently discard it.`);
    if (sample.phase && sample.phase !== label) throw new Error(`${label}: sample phase differs from its input.`);
    if (unique.has(key(sample))) throw new Error(`${label}: duplicate sample ${key(sample)}.`);
    unique.add(key(sample));
  }
  return { metadata: Array.isArray(value) ? {} : value, samples };
}

/** Cache conditions and paired sample identities are never pooled. The first
 * suite entry is not proof of a cold HTTP, Lambda, or DynamoDB cache. */
export function compareLiveRuns(beforeInput, afterInput) {
  const before = normalized(beforeInput, 'before'), after = normalized(afterInput, 'after');
  const missingMetadata = [];
  for (const field of ['origin', 'awsAccount', 'hostedBranch', 'activeRole', 'fixture', 'leads', 'clients']) {
    const a = before.metadata[field], b = after.metadata[field];
    if (a === undefined || b === undefined) missingMetadata.push(field);
    else if (a !== b) throw new Error(`Live runs are not matched: ${field} differs.`);
  }
  const afterByKey = new Map(after.samples.map(sample => [key(sample), sample]));
  if (before.samples.length !== after.samples.length || before.samples.some(sample => !afterByKey.has(key(sample)))) throw new Error('Before/after sample identities differ; capture the same suite and repetitions.');
  const groups = new Map();
  for (const sample of before.samples) {
    const id = groupKey(sample), value = groups.get(id) ?? { role: sample.role, flow: sample.flow, condition: sample.cacheCondition, before: [], after: [] };
    value.before.push(sample); value.after.push(afterByKey.get(key(sample))); groups.set(id, value);
  }
  const lines = ['# Live staging CRM latency comparison', '',
    'These are matched authenticated browser observations. First useful content means the next animation frame after the target DOM becomes useful. API completion means the last observed GraphQL response body; background work is reported separately from first content.', '',
    '**First visits and cached returns are separate.** A first suite visit has N=1 per flow and is a single observation, not a median estimate or a demonstrated cold cache. Same-document return medians have only the stated sample count. No p95, confidence interval, or population performance claim is inferred.', '',
  ];
  if (missingMetadata.length) lines.push(`**Comparability limitation:** missing metadata: ${missingMetadata.join(', ')}. Same environment/data/role could not be fully verified from these files.`, '');
  if (before.metadata.origin) lines.push(`Target: [staging CRM](${before.metadata.origin}). Role: ${before.metadata.activeRole ?? 'see sample rows'}. Dataset: ${before.metadata.leads ?? '?'} Leads and ${before.metadata.clients ?? '?'} Clients.`, '');
  if (before.metadata.frontendAsset || after.metadata.frontendAsset) lines.push(`Frontend asset: \`${before.metadata.frontendAsset ?? 'not recorded'}\` → \`${after.metadata.frontendAsset ?? 'not recorded'}\`.`, '');
  if (before.metadata.capturedAt || after.metadata.capturedAt) lines.push(`Capture windows: before ${before.metadata.capturedAt ?? 'not recorded'}; after ${after.metadata.capturedAt ?? 'not recorded'}.`, '');
  const conditions = [...new Set([...groups.values()].map(group => group.condition))];
  for (const condition of conditions) {
    lines.push(`## ${conditionNames[condition] ?? condition}`, '',
      '| Flow / role | N before / after | First useful ms, before → after | Change | Last API ms, before → after | GraphQL requests, before → after | JSON bytes, before → after | DOM rows, before → after |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const group of groups.values()) {
      if (group.condition !== condition) continue;
      const firstBefore = metric(group.before, 'firstUsefulDomFrameMs'), firstAfter = metric(group.after, 'firstUsefulDomFrameMs');
      const apiBefore = metric(group.before, 'lastGraphQLResponseMs'), apiAfter = metric(group.after, 'lastGraphQLResponseMs');
      const requestsBefore = metric(group.before, 'graphQLFetchCount'), requestsAfter = metric(group.after, 'graphQLFetchCount');
      const bytesBefore = metric(group.before, 'responseJsonBytes'), bytesAfter = metric(group.after, 'responseJsonBytes');
      const rowsBefore = metric(group.before, 'visibleRowsAtFinish'), rowsAfter = metric(group.after, 'visibleRowsAtFinish');
      const change = firstBefore.median > 0 ? `${number((firstAfter.median / firstBefore.median - 1) * 100)}%` : 'not defined';
      lines.push(`| ${group.flow} / ${group.role} | ${group.before.length} / ${group.after.length} | ${number(firstBefore.median)} → ${number(firstAfter.median)} | ${change} | ${number(apiBefore.median)} → ${number(apiAfter.median)} | ${number(requestsBefore.median)} → ${number(requestsAfter.median)} | ${number(bytesBefore.median)} → ${number(bytesAfter.median)} | ${number(rowsBefore.median)} → ${number(rowsAfter.median)} |`);
    }
    const repeated = [...groups.values()].filter(group => group.condition === condition && group.before.length > 1);
    if (repeated.length) {
      lines.push('', 'Observed first-content ranges (ms; descriptive only):');
      for (const group of repeated) {
        const a = metric(group.before, 'firstUsefulDomFrameMs'), b = metric(group.after, 'firstUsefulDomFrameMs');
        lines.push(`- ${group.flow} / ${group.role}: ${number(a.min)}–${number(a.max)} before; ${number(b.min)}–${number(b.max)} after.`);
      }
    }
    lines.push('');
  }
  const observerBefore = before.samples.map(sample => sample.observerParseCpuMs).filter(Number.isFinite);
  const observerAfter = after.samples.map(sample => sample.observerParseCpuMs).filter(Number.isFinite);
  if (observerBefore.length && observerAfter.length) lines.push(`Maximum recorded observer JSON parsing/byte-count CPU: ${number(Math.max(...observerBefore), 2)}ms before; ${number(Math.max(...observerAfter), 2)}ms after. Stream-cloning overhead was not independently isolated.`, '');
  lines.push('GraphQL counts are browser requests, not DynamoDB operation counts. Browser HTTP and AWS service caches are uncontrolled. First-page list observations may render fewer rows after pagination on larger datasets; DOM row counts are retained for context. Source data, projection readiness, authorization behavior, and completed exports need their separate checks.', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [before, after, output] = process.argv.slice(2);
  if (!before || !after) throw new Error('Usage: node scripts/live-performance-compare.mjs BEFORE.json AFTER.json [REPORT.md]');
  const markdown = compareLiveRuns(JSON.parse(readFileSync(resolve(before), 'utf8')), JSON.parse(readFileSync(resolve(after), 'utf8')));
  if (output) writeFileSync(resolve(output), markdown); else process.stdout.write(markdown);
}
