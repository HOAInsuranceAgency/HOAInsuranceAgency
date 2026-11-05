import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

async function waitFor(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(typeof message === 'function' ? message() : message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function diagnosticTail(path) {
  if (!existsSync(path)) return '(not created)';
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size, length = Math.min(size, 4096), buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(descriptor, buffer, 0, length, size - length)).toString('utf8');
  } finally { closeSync(descriptor); }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} to the verifier stops its owned descendant group before restoring output and permits a successor`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const paths = workspace(t), ready = join(paths.root, 'ready.json'), heartbeat = join(paths.root, 'heartbeat'), late = join(paths.root, 'late-write');
    const phases = join(paths.root, 'startup.log'), stdout = join(paths.root, 'driver.stdout'), stderr = join(paths.root, 'driver.stderr');
    buildOutput(paths.dist, 'original build');
    const original = lstatSync(paths.dist);
    writeFileSync(join(paths.directory, 'package.json'), JSON.stringify({ scripts: {
      'test:run': 'node child.mjs', typecheck: 'node following.mjs', build: 'node following.mjs', 'synth:check': 'node following.mjs',
    } }));
    writeFileSync(join(paths.directory, 'following.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(paths.root, 'following-command'))}, 'unexpected');`);
    writeFileSync(join(paths.directory, 'child.mjs'), `
      import { spawn } from 'node:child_process';
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(phases)}, 'child started pid=' + process.pid + '\\n');
      spawn(process.execPath, ['leaf.mjs'], { stdio: 'inherit' });
      setInterval(() => {}, 1000);
    `);
    // npm may exit immediately on the signal while its grandchild ignores it.
    // A cleanup that waits only for npm would restore dist under this writer.
    writeFileSync(join(paths.directory, 'leaf.mjs'), `
      import { execFileSync } from 'node:child_process';
      import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});
      appendFileSync(${JSON.stringify(phases)}, 'leaf started pid=' + process.pid + '; querying own process group\\n');
      // Piped spawnSync can throw EPERM in the audit sandbox after ps succeeds.
      // Regular files preserve the native result without requiring that pipe.
      const descriptors = [], groupOutput = ${JSON.stringify(join(paths.root, 'group.stdout'))};
      try {
        descriptors.push(openSync(groupOutput, 'wx', 0o600));
        descriptors.push(openSync(${JSON.stringify(join(paths.root, 'group.stderr'))}, 'wx', 0o600));
        execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { stdio: ['ignore', ...descriptors] });
      } finally { descriptors.forEach(descriptor => closeSync(descriptor)); }
      const group = Number(readFileSync(groupOutput, 'utf8').trim());
      if (!Number.isSafeInteger(group) || group <= 0) throw new Error('ps did not report a positive process group ID');
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ group }));
      setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);
      setTimeout(() => {
        writeFileSync(${JSON.stringify(late)}, 'descendant survived cancellation');
        writeFileSync(${JSON.stringify(join(paths.dist, 'late-child.txt'))}, 'unexpected');
      }, 1600);
    `);
    let ownedGroup;
    const descriptors = [stdout, stderr].map(path => openSync(path, 'wx', 0o600));
    let runner;
    try {
      runner = spawn(process.execPath, ['--input-type=module', '-e', `
        import { appendFileSync } from 'node:fs';
        appendFileSync(${JSON.stringify(phases)}, 'driver started pid=' + process.pid + '\\n');
        const { runOfflineVerification } = await import(${JSON.stringify(new URL('./verify-offline.mjs', import.meta.url).href)});
        process.exitCode = await runOfflineVerification({ directory: ${JSON.stringify(paths.directory)} });
      `], { detached: true, stdio: ['ignore', ...descriptors] });
    } finally { descriptors.forEach(descriptor => closeSync(descriptor)); }
    let exit, spawnError;
    runner.on('error', error => { spawnError = error; });
    runner.on('exit', (code, killedBy) => { exit = { code, signal: killedBy }; });
    t.after(async () => {
      // A startup failure may occur before the descendant can report its group.
      // Let the verifier stop its own command before forcing our driver group.
      if (!exit) {
        runner.kill('SIGTERM');
        await waitFor(() => exit !== undefined, 'The fixture driver did not stop during test cleanup', 6000).catch(() => {});
      }
      const groups = [runner.pid, ownedGroup];
      for (const group of new Set(groups)) {
        if (group > 0) try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    const diagnostic = () => `The fixture did not start. exit=${JSON.stringify(exit)} spawnError=${spawnError ? `${spawnError.code}: ${spawnError.message}` : 'none'}\nstartup:\n${diagnosticTail(phases)}\nstdout:\n${diagnosticTail(stdout)}\nstderr:\n${diagnosticTail(stderr)}`;
    await waitFor(() => existsSync(ready) && existsSync(heartbeat) || exit || spawnError, diagnostic);
    assert.equal(spawnError, undefined, diagnostic());
    assert.equal(exit, undefined, diagnostic());
    ownedGroup = JSON.parse(readFileSync(ready, 'utf8')).group;
    runner.kill(signal); // Signal the verifier itself, rather than its child.
    await new Promise(resolve => setTimeout(resolve, 50));
    runner.kill(signal); // A repeated signal cannot interrupt restoration.
    await waitFor(() => exit !== undefined, 'The verifier did not stop');
    assert.deepEqual(exit, { code: signal === 'SIGINT' ? 130 : 143, signal: null });
    assert.equal(existsSync(paths.config), false, 'temporary generated config must be removed');
    assert.equal(existsSync(paths.lock), false, 'the checkout lock must be released');
    assert.equal(lstatSync(paths.dist).ino, original.ino, 'restore the intact original output directory');
    assert.equal(readFileSync(join(paths.dist, 'index.html'), 'utf8'), 'original build');
    assert.equal(readFileSync(join(paths.dist, 'front-sidebar/index.html'), 'utf8'), 'original build');
    const stoppedHeartbeat = readFileSync(heartbeat, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(readFileSync(heartbeat, 'utf8'), stoppedHeartbeat, 'no descendant can write after cleanup');
    assert.equal(existsSync(late), false);
    assert.equal(existsSync(join(paths.dist, 'late-child.txt')), false);
    assert.equal(existsSync(join(paths.root, 'following-command')), false);
    assert.equal(await run(paths, () => ({ status: 0 })), 0, 'the next run can acquire the same checkout');
    assert.equal(readFileSync(join(paths.dist, 'index.html'), 'utf8'), 'original build');
  });
}

test('the plan runs the real test, combined type, complete build and both branch synth scripts', () => {
  const plan = offlinePlan('crm', '/fictional/crm');
  assert.deepEqual(plan.map(task => task.args), [
    ['run', 'test:run', '--', '--pool=forks', '--maxWorkers=2'], ['run', 'typecheck'], ['run', 'build'], ['run', 'synth:check'], ['run', 'synth:check'],
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
  assert.equal(env.NODE_OPTIONS, `${source.NODE_OPTIONS} --preserve-symlinks`);
  assert.equal(env.KEEP_NON_SECRET, 'yes');
  assert.equal(env.AWS_REGION, 'us-east-1');
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(env.AWS_CONFIG_FILE, devNull);
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, devNull);
  assert.equal(offlineEnvironment({}).NODE_OPTIONS, '--max-old-space-size=6144 --preserve-symlinks');
  const auditOptions = offlineEnvironment({ NODE_OPTIONS: '--disable-sigusr1' }).NODE_OPTIONS;
  assert.equal(auditOptions, '--disable-sigusr1 --preserve-symlinks');
  assert.equal(auditOptions.includes('--preserve-symlinks-main'), false);
  assert.equal(source.AWS_BRANCH, 'production'); // Do not mutate the caller environment.
});

test('a clean checkout gets a private minimal fixture only during checks, then no config or fixture bundle remains', async t => {
  const paths = workspace(t), calls = [];
  const status = await run(paths, (command, args, options) => {
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

test('existing generated configuration and complete build output survive successful verification byte-for-byte', async t => {
  const paths = workspace(t), configuration = '{"version":"1.3","custom":"existing fictional configuration"}\n';
  writeFileSync(paths.config, configuration);
  buildOutput(paths.dist, 'existing build');
  const oldConfig = lstatSync(paths.config), oldDist = lstatSync(paths.dist);
  assert.equal(await run(paths, (_command, args) => {
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

test('a failed build stops the plan, discards its fixture bundle, and restores the original output', async t => {
  const paths = workspace(t), calls = [];
  buildOutput(paths.dist, 'original build');
  assert.equal(await run(paths, (_command, args) => {
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

test('unstartable, thrown and interrupted child failures never continue or leave a generated config', async t => {
  for (const result of [{ status: null, error: new Error('missing npm') }, { status: null, signal: 'SIGTERM' }, undefined]) {
    const paths = workspace(t);
    let count = 0;
    assert.equal(await run(paths, () => { count++; if (result === undefined) throw new Error('spawn failed'); return result; }), 1);
    assert.equal(count, 1);
    assert.deepEqual(readdirSync(paths.directory), []);
  }
});

test('cleanup preserves a real outputs file written over the temporary fixture during verification', async t => {
  const paths = workspace(t), replacement = '{"version":"1.3","custom":"new real deployment output"}';
  assert.equal(await run(paths, () => { writeFileSync(paths.config, replacement); return { status: 0 }; }), 0);
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

test('overlapping verification cannot move the active output or release the first invocation lock', async t => {
  const paths = workspace(t);
  let checked = false;
  assert.equal(await run(paths, () => {
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

test('an unexpected replacement output is retained along with the original backup instead of being overwritten', async t => {
  const paths = workspace(t);
  buildOutput(paths.dist, 'original build');
  await assert.rejects(run(paths, (_command, args) => {
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
