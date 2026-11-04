import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2), baseline = args[0] === '--baseline' ? args.splice(0, 2)[1] : undefined;
if (baseline === '') throw new Error('Provide a Git revision after --baseline');
const crm = process.cwd(), report = resolve(args[0] ?? 'performance-audit-results.json');
let temporary;
try {
  let cwd = crm;
  if (baseline) {
    temporary = mkdtempSync(join(tmpdir(), 'hoa-crm-performance-'));
    const archive = spawnSync('git', ['archive', '--format=tar', baseline, 'crm', 'shared'], { cwd: resolve(crm, '..'), maxBuffer: 128 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(archive.error?.message ?? archive.stderr.toString());
    const extracted = spawnSync('tar', ['-x', '-C', temporary], { input: archive.stdout });
    if (extracted.status !== 0) throw new Error(extracted.stderr.toString());
    cwd = join(temporary, 'crm');
    symlinkSync(realpathSync(join(crm, 'node_modules')), join(cwd, 'node_modules'), 'dir');
    copyFileSync(join(crm, 'src/test/performanceFlowAudit.test.tsx'), join(cwd, 'src/test/performanceFlowAudit.test.tsx'));
  }
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/test/performanceFlowAudit.test.tsx'], {
    cwd, stdio: 'inherit', env: { ...process.env, CRM_PERF_AUDIT: '1', CRM_PERF_REPORT: report,
      CRM_PERF_REVISION: baseline ?? process.env.CRM_PERF_REVISION ?? 'working-tree' },
  });
  process.exitCode = result.status ?? 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
