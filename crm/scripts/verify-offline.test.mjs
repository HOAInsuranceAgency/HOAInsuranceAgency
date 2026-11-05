import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { offlineEnvironment, offlinePlan, prepareOfflineWorkspace, runOfflineVerification } from './verify-offline.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'hoa-offline-wrapper-test-')), directory = join(root, 'crm');
  mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, config: join(directory, 'amplify_outputs.json'), dist: join(directory, 'dist'), lock: join(directory, 'verify-offline.lock') };
}
function buildOutput(dist, value = 'offline fixture bundle') {
  mkdirSync(join(dist, 'front-sidebar'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), value);
  writeFileSync(join(dist, 'front-sidebar/index.html'), value);
}
const run = (paths, execute, extra = {}) => runOfflineVerification({ directory: paths.directory, temporaryRoot: paths.root, execute, environment: {}, log: () => {}, ...extra });

test('the plan runs the real test, combined type, complete build and both branch synth scripts', () => {
  const plan = offlinePlan('crm', '/fictional/crm');
  assert.deepEqual(plan.map(task => task.args), [
    ['run', 'test:run'], ['run', 'typecheck'], ['run', 'build'], ['run', 'synth:check'], ['run', 'synth:check'],
  ]);
  assert.ok(plan.every(task => task.cwd === '/fictional/crm' && ['npm', 'npm.cmd'].includes(task.command)));
  assert.deepEqual(plan.map(task => task.env), [{}, {}, {}, { AWS_BRANCH: 'main' }, { AWS_BRANCH: 'staging' }]);
});

test('invalid scopes fail before creating config, output, locks, temporary directories or child processes', t => {
  const paths = workspace(t), before = readdirSync(paths.root);
  assert.throws(() => run(paths, () => { throw new Error('must not execute'); }, { scope: 'all' }), /Unknown offline verification scope/);
  assert.deepEqual(readdirSync(paths.root), before);
  assert.deepEqual(readdirSync(paths.directory), []);
});

test('offline children cannot inherit credentials or deployment controls, and retain Node resolver options', () => {
  const source = {
    PATH: '/fictional/bin', KEEP_NON_SECRET: 'yes', NODE_OPTIONS: '--preserve-symlinks --max-old-space-size=6144',
    AWS_ACCESS_KEY_ID: 'private', AWS_SECRET_ACCESS_KEY: 'private', AWS_SESSION_TOKEN: 'private', AWS_PROFILE: 'production',
    AWS_BRANCH: 'production', AWS_REGION: 'private-region', CDK_CONTEXT_JSON: 'private',
    HOA_DEPLOYMENT_MODE: 'production', VITE_HOA_MIGRATION_PREVIEW: 'true', PUBLIC_HOA_MIGRATION_PREVIEW: 'true',
    SENTRY_AUTH_TOKEN: 'private', VITE_SENTRY_DSN: 'private', PUBLIC_SENTRY_DSN: 'private', PUBLIC_CRM_API_KEY: 'private',
    AMPLIFY_ENV: 'production', GOOGLE_SIGN_IN_ENABLED: 'true', OPENAI_API_KEY: 'private', ANTHROPIC_API_KEY: 'private',
  };
  const env = offlineEnvironment(source);
  for (const key of Object.keys(source)) {
    if (!['PATH', 'KEEP_NON_SECRET', 'NODE_OPTIONS', 'AWS_REGION'].includes(key)) assert.equal(env[key], undefined, key);
  }
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.NODE_OPTIONS, source.NODE_OPTIONS);
  assert.equal(env.KEEP_NON_SECRET, 'yes');
  assert.equal(env.AWS_REGION, 'us-east-1');
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(env.AWS_CONFIG_FILE, devNull);
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, devNull);
  assert.equal(offlineEnvironment({}).NODE_OPTIONS, '--max-old-space-size=6144');
  assert.equal(source.AWS_BRANCH, 'production'); // Do not mutate the caller environment.
});

test('a clean checkout gets a private minimal fixture only during checks, then no config or fixture bundle remains', t => {
  const paths = workspace(t), calls = [];
  const status = run(paths, (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(JSON.parse(readFileSync(paths.config, 'utf8')).version, '1.3');
    assert.equal(lstatSync(paths.config).mode & 0o777, 0o600);
    assert.equal(options.env.AWS_EC2_METADATA_DISABLED, 'true');
    if (args[1] === 'build') buildOutput(paths.dist);
    return { status: 0 };
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(call => call.options.env.AWS_BRANCH), [undefined, undefined, undefined, 'main', 'staging']);
  assert.equal(existsSync(paths.config), false);
  assert.equal(existsSync(paths.dist), false);
  assert.equal(existsSync(paths.lock), false);
  assert.deepEqual(readdirSync(paths.root), ['crm']);
});

test('existing generated configuration and complete build output survive successful verification byte-for-byte', t => {
  const paths = workspace(t), configuration = '{"version":"1.3","custom":"existing fictional configuration"}\n';
  writeFileSync(paths.config, configuration);
  buildOutput(paths.dist, 'existing build');
  const oldConfig = lstatSync(paths.config), oldDist = lstatSync(paths.dist);
  assert.equal(run(paths, (_command, args) => {
    if (args[1] === 'build') buildOutput(paths.dist);
    return { status: 0 };
  }), 0);
  assert.equal(readFileSync(paths.config, 'utf8'), configuration);
  assert.equal(lstatSync(paths.config).ino, oldConfig.ino);
  assert.equal(lstatSync(paths.config).mtimeMs, oldConfig.mtimeMs);
  assert.equal(lstatSync(paths.dist).ino, oldDist.ino);
  assert.equal(readFileSync(join(paths.dist, 'index.html'), 'utf8'), 'existing build');
  assert.equal(readFileSync(join(paths.dist, 'front-sidebar/index.html'), 'utf8'), 'existing build');
  assert.deepEqual(readdirSync(paths.root), ['crm']);
});

test('a failed build stops the plan, discards its fixture bundle, and restores the original output', t => {
  const paths = workspace(t), calls = [];
  buildOutput(paths.dist, 'original build');
  assert.equal(run(paths, (_command, args) => {
    calls.push(args[1]);
    if (args[1] === 'build') { buildOutput(paths.dist); return { status: 7 }; }
    return { status: 0 };
  }), 7);
  assert.deepEqual(calls, ['test:run', 'typecheck', 'build']);
  assert.equal(existsSync(paths.config), false);
  assert.equal(existsSync(paths.lock), false);
  assert.equal(readFileSync(join(paths.dist, 'index.html'), 'utf8'), 'original build');
  assert.equal(readFileSync(join(paths.dist, 'front-sidebar/index.html'), 'utf8'), 'original build');
});

test('unstartable, thrown and interrupted child failures never continue or leave a generated config', t => {
  for (const result of [{ status: null, error: new Error('missing npm') }, { status: null, signal: 'SIGTERM' }, undefined]) {
    const paths = workspace(t);
    let count = 0;
    assert.equal(run(paths, () => { count++; if (result === undefined) throw new Error('spawn failed'); return result; }), 1);
    assert.equal(count, 1);
    assert.deepEqual(readdirSync(paths.directory), []);
  }
});

test('cleanup preserves a real outputs file written over the temporary fixture during verification', t => {
  const paths = workspace(t), replacement = '{"version":"1.3","custom":"new real deployment output"}';
  assert.equal(run(paths, () => { writeFileSync(paths.config, replacement); return { status: 0 }; }), 0);
  assert.equal(readFileSync(paths.config, 'utf8'), replacement);
});

test('cleanup cannot remove a different outputs file even if its contents equal the fixture', t => {
  const paths = workspace(t);
  const cleanup = prepareOfflineWorkspace(paths.directory, paths.root);
  const fixtureBytes = readFileSync(paths.config);
  renameSync(paths.config, join(paths.root, 'original-fixture'));
  writeFileSync(paths.config, fixtureBytes);
  cleanup();
  assert.deepEqual(readFileSync(paths.config), fixtureBytes);
  assert.equal(existsSync(paths.lock), false);
});

test('overlapping verification cannot move the active output or release the first invocation lock', t => {
  const paths = workspace(t);
  let checked = false;
  assert.equal(run(paths, () => {
    if (!checked) {
      checked = true;
      const identity = lstatSync(paths.dist).ino;
      assert.throws(() => run(paths, () => { throw new Error('must not execute'); }), /already running/);
      assert.equal(lstatSync(paths.dist).ino, identity);
      assert.equal(existsSync(paths.lock), true);
    }
    return { status: 0 };
  }), 0);
  assert.deepEqual(readdirSync(paths.directory), []);
});

test('an unexpected replacement output is retained along with the original backup instead of being overwritten', t => {
  const paths = workspace(t);
  buildOutput(paths.dist, 'original build');
  assert.throws(() => run(paths, (_command, args) => {
    if (args[1] === 'build') {
      renameSync(paths.dist, join(paths.root, 'old-offline-dist'));
      buildOutput(paths.dist, 'another process output');
    }
    return { status: 0 };
  }), /replaced by another process.*Original output is preserved at/);
  assert.equal(readFileSync(join(paths.dist, 'index.html'), 'utf8'), 'another process output');
  const preserved = readdirSync(paths.root).find(name => name.startsWith('hoa-crm-offline-'));
  assert.equal(readFileSync(join(paths.root, preserved, 'original-dist/index.html'), 'utf8'), 'original build');
  assert.equal(existsSync(paths.config), false);
  assert.equal(existsSync(paths.lock), false);
});
