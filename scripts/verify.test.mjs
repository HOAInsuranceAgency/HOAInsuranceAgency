import assert from 'node:assert/strict';
import test from 'node:test';
import { verificationEnvironment, synthEnvironment, verificationPlan, runVerification, prepareVerificationOutputs } from './verify.mjs';
import { assertSteadyState } from '../crm/amplify/steady-state.mjs';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../crm/package.json', import.meta.url));
const { load } = require('js-yaml');

test('verification is fail-fast for failed, interrupted or unstartable commands', () => {
  for (const result of [{ status: 9 }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('missing executable') }]) {
    const calls = [];
    const plan = [{ name: 'first', command: 'first', args: [], env: {} }, { name: 'second', command: 'second', args: [], env: {} }];
    assert.notEqual(runVerification(plan, command => { calls.push(command); return result; }, {}), 0);
    assert.deepEqual(calls, ['first']);
  }
});

test('clean checkouts receive a temporary offline config without replacing existing or subsequently generated outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'hoa-verification-tests-'));
  const path = join(root, 'crm/amplify_outputs.json');
  mkdirSync(join(root, 'crm'));
  try {
    let cleanup = prepareVerificationOutputs(root);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, '1.3');
    cleanup();
    assert.equal(existsSync(path), false);
    writeFileSync(path, 'existing configuration');
    cleanup = prepareVerificationOutputs(root);
    cleanup();
    assert.equal(readFileSync(path, 'utf8'), 'existing configuration');
    rmSync(path);
    cleanup = prepareVerificationOutputs(root);
    writeFileSync(path, 'configuration generated while verification ran');
    cleanup();
    assert.equal(readFileSync(path, 'utf8'), 'configuration generated while verification ran');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verification does not inherit credentials, monitoring uploads or deployment controls', () => {
  const env = verificationEnvironment({ PATH: '/bin', AWS_ACCESS_KEY_ID: 'private', AWS_PROFILE: 'production', SENTRY_AUTH_TOKEN: 'private', HOA_MIGRATION_AUTH: 'true', PUBLIC_CRM_API_KEY: 'private', VITE_HOA_MIGRATION_PREVIEW: 'true' });
  assert.equal(env.PATH, '/bin');
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'SENTRY_AUTH_TOKEN', 'HOA_MIGRATION_AUTH', 'PUBLIC_CRM_API_KEY', 'VITE_HOA_MIGRATION_PREVIEW']) assert.equal(env[key], undefined);
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
});

test('both offline synth environments match the retained deployment contracts', () => {
  for (const target of ['main', 'staging']) {
    const contract = JSON.parse(readFileSync(new URL(`../crm/amplify/steady-state-${target}.json`, import.meta.url), 'utf8'));
    assert.doesNotThrow(() => assertSteadyState(synthEnvironment(target), contract));
  }
  assert.throws(() => synthEnvironment('foreign'), /Unknown synth target/);
});

test('all verification includes both apps and scopes cannot silently skip their checks', () => {
  const all = verificationPlan().map(task => task.name);
  assert.ok(all.includes('crm: preview:check'));
  for (const required of ['module boundaries', 'crm: test:run', 'crm: build', 'crm: typecheck:backend', 'backend synth: main', 'backend synth: staging', 'web: typecheck', 'web: articles:test', 'web: articles:build-test', 'web: test:sentry', 'web: build', 'web: seo:check']) assert.ok(all.includes(required), required);
  assert.ok(verificationPlan('web').every(task => !task.name.startsWith('crm:') && !task.name.startsWith('backend synth:')));
  assert.ok(verificationPlan('backend').some(task => task.name === 'backend synth: staging'));
  assert.throws(() => verificationPlan('typo'), /Unknown verification scope/);
});

test('ordinary app PRs run the standard verifier without credentials or write permissions', () => {
  const workflow = load(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.pull_request, { branches: ['main', 'staging'] });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(JSON.stringify(workflow).includes('secrets.'), false);
  const steps = workflow.jobs.verify.steps;
  assert.ok(steps.some(step => step.run?.trim() === 'npm run verify'));
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(steps.some(step => step.uses?.startsWith('actions/setup-node@') && step.with['node-version'] === '22'));
});
