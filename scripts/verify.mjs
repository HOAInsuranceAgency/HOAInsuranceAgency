import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scopes = new Set(['all', 'crm', 'web', 'backend', 'architecture']);

/** Satisfy the generated module import in clean checkouts without fetching a real backend. */
export function prepareVerificationOutputs(root = repository) {
  const path = join(root, 'crm/amplify_outputs.json');
  const fixture = JSON.stringify({ version: '1.3', _comment: 'Temporary offline verification fixture; not a deployment configuration.' }) + '\n';
  try { writeFileSync(path, fixture, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return () => {}; throw error; }
  return () => {
    try { if (readFileSync(path, 'utf8') === fixture) unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

/** Verification builds are offline: never upload monitoring data or inherit deployment controls. */
export function verificationEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:AWS_|CDK_|HOA_|VITE_HOA_|PUBLIC_HOA_|SENTRY_|VITE_SENTRY_|PUBLIC_SENTRY_|PUBLIC_CRM_)/.test(key)));
  return { ...env, AWS_EC2_METADATA_DISABLED: 'true', ASTRO_TELEMETRY_DISABLED: '1',
    PUBLIC_ANALYTICS_DISABLED: 'true', NODE_OPTIONS: env.NODE_OPTIONS || '--max-old-space-size=6144' };
}

/** Non-secret, local synth settings derived from the same retained contracts as deployment. */
export function synthEnvironment(target) {
  if (!['main', 'staging'].includes(target)) throw new Error(`Unknown synth target: ${target}`);
  const contract = JSON.parse(readFileSync(join(repository, `crm/amplify/steady-state-${target}.json`), 'utf8'));
  return {
    AWS_REGION: contract.region, AWS_DEFAULT_REGION: contract.region,
    AWS_APP_ID: contract.crmApp, AWS_BRANCH: contract.branch, HOA_DEPLOY_ACCOUNT_ID: contract.account,
    HOA_DEPLOYMENT_MODE: 'steady-state', HOA_MIGRATION_AUTH: 'true', HOA_MIGRATION_PREVIEW: 'false',
    HOA_MIGRATION_STREAM_PHASE: 'armed', HOA_MIGRATION_WORKERS_ENABLED: 'true',
    HOA_MIGRATION_STREAM_PROBE_ENABLED: 'false', HOA_MIGRATION_SCHEDULES_ENABLED: 'true',
    HOA_TRANSACTIONAL_MAIL_RELEASE: 'true', HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED: 'false',
    HOA_PREVIEW_ADMIN_LOGIN: 'false', HOA_RESEND_PREVIEW_ENABLED: 'false',
    HOA_MIGRATION_PENDING_CUTOFF: contract.pendingCutoff, HOA_MIGRATION_PENDING_ACCOUNT: contract.account,
    HOA_PREVIEW_ADMIN_USER_POOL_ID: contract.pool, HOA_PREVIEW_ADMIN_CLIENT_ID: contract.client,
    VITE_HOA_MIGRATION_PREVIEW: 'false', VITE_HOA_MIGRATION_AUTH: 'true', VITE_HOA_PREVIEW_ADMIN_LOGIN: 'false',
  };
}

export function verificationPlan(scope = 'all') {
  if (!scopes.has(scope)) throw new Error(`Unknown verification scope: ${scope}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const script = (app, name, env = {}) => ({ name: `${app}: ${name}`, command: npm,
    args: ['run', name], cwd: join(repository, app), env });
  const tests = readdirSync(join(repository, 'scripts')).filter(name => name.endsWith('.test.mjs')).sort();
  const plan = [
    { name: 'verification tooling tests', command: process.execPath,
      args: ['--test', ...tests.map(name => `scripts/${name}`)], cwd: repository, env: {} },
    { name: 'module boundaries', command: process.execPath, args: ['scripts/check-module-boundaries.mjs'], cwd: repository, env: {} },
  ];
  if (scope === 'all' || scope === 'architecture') plan.push({ name: 'audit publisher safeguards', command: 'python3',
    args: ['-m', 'unittest', 'discover', '-s', '.github/scripts', '-p', 'test_*.py', '-v'], cwd: repository, env: {} });
  if (scope === 'architecture') plan.push(script('crm', 'test:architecture'));
  if (scope === 'all' || scope === 'crm') plan.push(script('crm', 'test:run'), script('crm', 'build'), script('crm', 'preview:check'));
  if (['all', 'crm', 'backend'].includes(scope)) {
    plan.push(script('crm', 'typecheck:backend'));
    for (const target of ['main', 'staging']) {
      plan.push({ ...script('crm', 'synth:check', synthEnvironment(target)), name: `backend synth: ${target}` });
    }
  }
  if (scope === 'all' || scope === 'web') {
    for (const name of ['articles:test', 'articles:build-test', 'test:sentry', 'typecheck', 'build', 'seo:check']) {
      plan.push(script('web', name));
    }
  }
  return plan;
}

export function runVerification(plan, execute = spawnSync, sourceEnvironment = process.env) {
  const env = verificationEnvironment(sourceEnvironment);
  for (const task of plan) {
    console.log(`\nVerifying ${task.name}`);
    const result = execute(task.command, task.args, { cwd: task.cwd, env: { ...env, ...task.env }, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      console.error(`Verification failed: ${task.name}${result.error ? ` (${result.error.message})` : ''}`);
      return result.status > 0 ? result.status : 1;
    }
  }
  console.log('\nVerification passed.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0] && !/^--scope=\w+$/.test(args[0])) {
    console.error('Usage: node scripts/verify.mjs [--scope=all|crm|web|backend|architecture]');
    process.exitCode = 1;
  } else {
    try {
      const scope = args[0]?.slice('--scope='.length) || 'all';
      const plan = verificationPlan(scope);
      const cleanup = ['all', 'crm'].includes(scope) ? prepareVerificationOutputs() : () => {};
      try { process.exitCode = runVerification(plan); }
      finally { cleanup(); }
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
