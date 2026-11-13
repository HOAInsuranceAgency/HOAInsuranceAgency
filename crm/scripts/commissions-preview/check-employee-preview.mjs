/** P04: evaluate the actual packaged preview in a local DOM, without network or CRM writes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
const html = await readFile(process.argv[2], 'utf8');
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:8792/?scenario=shared&role=producer',
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
  beforeParse(window) { window.structuredClone = structuredClone; },
});
try {
  const document = dom.window.document;
  for(let attempt=0;attempt<100&&!document.querySelector('main')?.textContent.includes('Producer earned');attempt++)
    await new Promise(resolve=>setTimeout(resolve,20));
  const main=document.querySelector('main');assert.ok(main,'Preview rendered');
  const text=main.textContent;
  assert.match(text,/\$440\.00/);
  assert.match(text,/\$120\.00/);
  assert.doesNotMatch(text,/Jordan Hayes|\$64\.00/);
  const tabs=[...document.querySelectorAll('[role="tab"]')].map(e=>e.textContent);
  for(const name of ['Work queue','Statements','Payroll','Reviews & exceptions','Setup'])assert.ok(!tabs.includes(name),name+' is hidden');
  const reports=[...document.querySelectorAll('a[aria-label^="View PDF:"]')];
  assert.equal(reports.length,4);
  assert.ok(reports.every(link=>link.getAttribute('aria-label').includes('Avery Brooks earnings')));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({section:'P04',method:'Local DOM execution of the packaged React preview',earned:'$440.00',sharedEarnings:'$120.00',otherEmployeeHidden:true,ownerControlsHidden:true,ownSampleReports:4,errors},null,2));
} finally { dom.window.close(); }
