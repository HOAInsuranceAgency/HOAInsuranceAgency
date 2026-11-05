import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const crmDirectory = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.stringify({ version: '1.3', _comment: 'Temporary offline verification fixture; not a deployment configuration.' }) + '\n';
const info = path => {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};
const sameFile = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino;

/** Keep deployment controls and credentials outside these offline subprocesses. */
export function offlineEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:AWS_|CDK_|HOA_|VITE_HOA_|PUBLIC_HOA_|SENTRY_|VITE_SENTRY_|PUBLIC_SENTRY_|PUBLIC_CRM_|AMPLIFY_|GOOGLE_|OPENAI_|ANTHROPIC_)/.test(key)));
  return { ...env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: devNull, AWS_SHARED_CREDENTIALS_FILE: devNull,
    ASTRO_TELEMETRY_DISABLED: '1', NODE_OPTIONS: env.NODE_OPTIONS || '--max-old-space-size=6144' };
}

/** The normal scripts remain authoritative. No deployments, migrations or command retries. */
export function offlinePlan(scope = 'crm', directory = crmDirectory) {
  if (scope !== 'crm') throw new Error(`Unknown offline verification scope: ${scope}`);
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const task = (name, script, env = {}) => ({ name, command, args: ['run', script], cwd: directory, env });
  return [task('CRM tests', 'test:run'), task('CRM and backend types', 'typecheck'), task('CRM production build', 'build'),
    task('Backend synth: main', 'synth:check', { AWS_BRANCH: 'main' }),
    task('Backend synth: staging', 'synth:check', { AWS_BRANCH: 'staging' })];
}

/** Preserve existing configuration without inspecting it. Only an unchanged file
 * created here may be removed. Existing dist is moved intact and restored even
 * when a check fails, so the fixture bundle can never replace that output. */
export function prepareOfflineWorkspace(directory, temporaryRoot = directory) {
  const lockPath = join(directory, 'verify-offline.lock'), outputPath = join(directory, 'amplify_outputs.json'), dist = join(directory, 'dist');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Offline verification is already running in this CRM checkout.');
    throw error;
  }
  const lockIdentity = fstatSync(lock);
  closeSync(lock);
  let temporary, backedUp = false, distIdentity, outputIdentity;
  const cleanup = () => {
    const errors = [];
    try {
      if (outputIdentity && sameFile(info(outputPath), outputIdentity) && readFileSync(outputPath, 'utf8') === fixture) unlinkSync(outputPath);
    } catch (error) { errors.push(error); }
    try {
      const current = info(dist);
      if (distIdentity && current && !sameFile(current, distIdentity)) throw new Error('The offline build output was replaced by another process; it was left untouched.');
      if (distIdentity && current) rmSync(dist, { recursive: true });
      if (backedUp) {
        if (info(dist)) throw new Error('The original build output cannot be restored over another process\'s files.');
        renameSync(join(temporary, 'original-dist'), dist);
        backedUp = false;
      }
    } catch (error) {
      errors.push(new Error(`${error.message}${backedUp ? ` Original output is preserved at ${join(temporary, 'original-dist')}.` : ''}`));
    }
    try { if (temporary && !backedUp) rmSync(temporary, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    try { if (sameFile(info(lockPath), lockIdentity)) unlinkSync(lockPath); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  };
  try {
    temporary = mkdtempSync(join(temporaryRoot, 'hoa-crm-offline-'));
    if (info(dist)) { renameSync(dist, join(temporary, 'original-dist')); backedUp = true; }
    mkdirSync(dist);
    distIdentity = info(dist);
    let descriptor;
    try {
      descriptor = openSync(outputPath, 'wx', 0o600);
      outputIdentity = fstatSync(descriptor);
      writeFileSync(descriptor, fixture);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
    return cleanup;
  } catch (error) {
    try { cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `${error.message}\n${cleanupError.message}`); }
    throw error;
  }
}

export function runOfflineVerification({ directory = crmDirectory, scope = 'crm', execute = spawnSync, environment = process.env, temporaryRoot = directory, log = console.log } = {}) {
  // Validate the complete plan before locking, moving outputs or creating a fixture.
  const plan = offlinePlan(scope, directory), env = offlineEnvironment(environment);
  const cleanup = prepareOfflineWorkspace(directory, temporaryRoot);
  try {
    for (const task of plan) {
      log(`Verifying ${task.name}`);
      let result;
      try { result = execute(task.command, task.args, { cwd: task.cwd, env: { ...env, ...task.env }, stdio: 'inherit' }); }
      catch (error) { log(`Verification failed: ${task.name} (${error.message})`); return 1; }
      if (result.error || result.status !== 0) {
        log(`Verification failed: ${task.name}${result.error ? ` (${result.error.message})` : result.signal ? ` (${result.signal})` : ''}`);
        return result.status > 0 ? result.status : 1;
      }
    }
    log('Offline CRM verification passed. Build artifacts are discarded; this does not deploy a backend.');
    return 0;
  } finally { cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1 || args[0] && args[0] !== '--scope=crm') throw new Error('Usage: node scripts/verify-offline.mjs [--scope=crm]');
    process.exitCode = runOfflineVerification();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
