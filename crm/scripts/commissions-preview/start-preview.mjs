/** Start the fictional commission preview; no AWS configuration or mail access. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { generateReportSamples } from './generate-report-samples.mjs';
const crm = fileURLToPath(new URL('../../', import.meta.url));
const vite = join(crm, 'node_modules/vite/bin/vite.js');
const config = 'scripts/commissions-preview/vite.config.ts';
const url = 'http://127.0.0.1:8792/?scenario=shared';

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vite, ...args], { cwd: crm, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Preview command exited with code ' + code)));
  });
}
try {
  await generateReportSamples(join(crm, 'scripts/commissions-preview/review-pdfs'));
  await run(['build', '--config', config, '--configLoader', 'runner']);
  let response;
  try { response = await fetch(url, {signal: AbortSignal.timeout(1500)}); } catch {}
  if (response) {
    if (!response.ok || !(await response.text()).includes('<title>Commission workflow preview</title>')) {
      throw new Error('Port 8792 is occupied by another application. Nothing was stopped or replaced.');
    }
    console.log('\nThe commission preview is already running:\n' + url);
  } else {
    console.log('\nOpen ' + url + '\nKeep this window open while using the local preview. Close it to stop.\n');
    await run(['preview', '--config', config, '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '8792', '--strictPort']);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('Make sure the CRM dependencies are installed, then run this launcher again.');
  process.exitCode = 1;
}
