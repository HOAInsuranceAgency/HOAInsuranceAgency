// @vitest-environment node
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

it('verifies retained backend resources after deployment before the frontend can fail', () => {
  const spec = load(readFileSync(new URL('../../../amplify.yml', import.meta.url), 'utf8')) as {
    applications: { appRoot: string; backend?: { phases: { build: { commands: string[] } } } }[];
  };
  const commands = spec.applications.find(app => app.appRoot === 'crm')!.backend!.phases.build.commands;
  const deploy = commands.indexOf('node scripts/deploy-migration-backend.mjs');
  const guards = commands.flatMap((command, index) => command === 'node scripts/assert-migration-destination.mjs' ? [index] : []);
  expect(deploy).toBeGreaterThan(-1);
  expect(guards.some(index => index < deploy)).toBe(true);
  expect(guards.some(index => index > deploy)).toBe(true);
  expect(commands.at(-1)).toBe('node scripts/assert-migration-destination.mjs');
});
