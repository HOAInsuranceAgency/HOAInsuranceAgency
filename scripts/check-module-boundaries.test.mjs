import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { inspectSource, moduleBoundaryViolations } from './check-module-boundaries.mjs';

const root = resolve('/fixture');
const inspect = (source, file = 'shared/rules.ts') => inspectSource(source, resolve(root, file), root);

test('shared imports, re-exports, require and dynamic imports cannot introduce SDK dependencies', () => {
  for (const source of ['import { x } from "aws-amplify";', 'export * from "react";', 'const x = require("node:fs");', 'const x = import("../crm/src/lib/client");', 'const x = import(target);']) {
    assert.ok(inspect(source).length, source);
  }
  assert.equal(inspect('import type { Thing } from "../crm/src/lib/client";').length, 1);
});

test('shared rules accept local pure dependencies but reject environment and browser state', () => {
  assert.deepEqual(inspect('import { x } from "./rules"; export type { Y } from "./types"; const text = "window process.env"; // localStorage'), []);
  for (const source of ['window.location', 'localStorage.getItem("x")', 'sessionStorage.clear()', 'process.env.TOKEN']) assert.ok(inspect(source).length);
});

test('browser schema imports must be type-only, including named import/export syntax', () => {
  const path = 'crm/src/lib/types.ts';
  for (const source of ['import type { Schema } from "../../amplify/data/resource";', 'import { type Schema } from "../../amplify/data/resource";', 'export type { Schema } from "../../amplify/data/resource";']) assert.deepEqual(inspect(source, path), []);
  assert.equal(inspect('import { data } from "../../amplify/data/resource";', path).length, 1);
  assert.equal(inspect('export { data } from "../../amplify/data/resource";', path).length, 1);
});

test('primitives and Lambda handlers cannot pull in feature/browser client dependencies', () => {
  assert.equal(inspect('import { client } from "../../lib/client";', 'crm/src/components/ui/Button.tsx').length, 1);
  assert.equal(inspect('import { client } from "../../../src/lib/client";', 'crm/amplify/functions/example/handler.ts').length, 1);
  assert.deepEqual(inspect('import { Button } from "./Button"; import * as React from "react";', 'crm/src/components/ui/Tabs.tsx'), []);
});

test('current production modules satisfy the enforced boundaries', () => assert.deepEqual(moduleBoundaryViolations(), []));
