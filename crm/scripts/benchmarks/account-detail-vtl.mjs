// Optional read-only AWS verification. Run from crm:
// node --import tsx scripts/benchmarks/account-detail-vtl.mjs
// Evaluates synthetic contexts; never reads CRM data or deploys resources.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { administratorListBypassTemplate } from '../../amplify/functions/crm-access/list-scope.ts';
const run = promisify(execFile);
const cases = [
  { name: 'Owner broad', groups: ['OWNER'], expected: 'bypass' },
  { name: 'Admin broad', groups: ['ADMIN'], expected: 'bypass' },
  { name: 'Owner exact account', groups: ['OWNER'], filter: { accountId: { eq: 'a' } }, expected: 'invoke' },
  { name: 'Admin exact account', groups: ['ADMIN'], filter: { accountId: { eq: 'a' } }, expected: 'invoke' },
  { name: 'Owner empty equality', groups: ['OWNER'], filter: { accountId: { eq: '' } }, expected: 'bypass' },
  { name: 'Owner OR only', groups: ['OWNER'], filter: { or: [{ accountId: { eq: 'a' } }, { accountId: { eq: 'b' } }] }, expected: 'bypass' },
  // EvaluateMappingTemplate normalizes omitted identity.groups to [], so
  // claims-only contexts retain the existing fail-closed invocation path.
  { name: 'Evaluator normalizes omitted groups to empty', claims: { 'cognito:groups': ['OWNER'] }, expected: 'invoke' },
  { name: 'Narrowed Producer broad', groups: ['OWNER', 'PRODUCER'], headers: { 'x-crm-role': 'PRODUCER' }, expected: 'invoke' },
  { name: 'Spoofed Owner broad', groups: ['PRODUCER'], headers: { 'x-crm-role': 'OWNER' }, expected: 'invoke' },
  { name: 'Duplicate role headers', groups: ['OWNER'], headers: { 'x-crm-role': 'OWNER', 'X-CRM-ROLE': 'OWNER' }, expected: 'invoke' },
  { name: 'Owner document incomplete scope', model: 'Document', groups: ['OWNER'], filter: { entityId: { eq: 'a' } }, expected: 'bypass' },
  { name: 'Owner document exact pair', model: 'Document', groups: ['OWNER'], filter: { entityId: { eq: 'a' }, entityType: { eq: 'ACCOUNT' } }, expected: 'invoke' },
  { name: 'Owner indirect root', model: 'InvoiceLine', groups: ['OWNER'], filter: { accountId: { eq: 'a' } }, expected: 'invoke' },
  { name: 'Owner indirect parent', model: 'InvoiceLine', groups: ['OWNER'], filter: { invoiceId: { eq: 'i' } }, expected: 'invoke' },
];
const results = new Array(cases.length); let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < cases.length) {
    const index = next++, test = cases[index];
    const context = { arguments: test.filter ? { filter: test.filter } : {}, identity: { sub: 'synthetic-user', ...(test.groups ? { groups: test.groups } : {}), claims: test.claims ?? {} },
      request: { headers: test.headers ?? {} }, prev: { result: { path: 'bypass' } } };
    const result = await run('aws', ['appsync', 'evaluate-mapping-template', '--region', 'us-east-1', '--template', administratorListBypassTemplate(test.model ?? 'Contact') + '{"path":"invoke"}', '--context', JSON.stringify(context), '--no-cli-pager']);
    const response = JSON.parse(result.stdout);
    if (response.error || JSON.parse(response.outErrors ?? '[]').length) throw new Error(`${test.name}: ${JSON.stringify(response)}`);
    const path = JSON.parse(response.evaluationResult).path;
    if (path !== test.expected) throw new Error(`${test.name}: expected ${test.expected}, received ${path}`);
    results[index] = { name: test.name, model: test.model ?? 'Contact', expected: test.expected, observed: path, passed: true };
  }
}));
const destination = new URL('../performance-audit-results/detail-vtl-evaluation.json', import.meta.url);
mkdirSync(new URL('../performance-audit-results/', import.meta.url), { recursive: true });
writeFileSync(destination, `${JSON.stringify({ method: 'AWS AppSync EvaluateMappingTemplate; actual installed bypass snippet, synthetic contexts only', region: 'us-east-1', results }, null, 2)}\n`);
console.log(`${results.length} actual AppSync VTL evaluations passed.`);
