// Generate an authenticated Chrome DevTools Console helper, without reading
// credentials or CRM data locally. Cloud actions are existing read-only UI
// navigations; request bodies/responses and record names never enter results.
// node scripts/live-flow-observer.mjs --origin https://STAGING --role OWNER \
//   --phase before --out /tmp/hoa-crm-before-observer.js
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]));
if (!options.origin || !options.out || !['before', 'after'].includes(options.phase) || !['OWNER', 'ADMIN', 'PRODUCER', 'STAFF'].includes(options.role)) throw new Error('Required: --origin HTTPS_STAGING_ORIGIN|current-staging --role OWNER|ADMIN|PRODUCER|STAFF --phase before|after --out PATH');
const automaticOrigin = options.origin === 'current-staging';
const origin = automaticOrigin ? undefined : new URL(options.origin);
if (origin && (origin.protocol !== 'https:' || origin.origin !== options.origin.replace(/\/$/, ''))) throw new Error('Provide the exact HTTPS staging origin.');

function install(config) {
  if (config.currentStaging) {
    if (location.protocol !== 'https:' || !/(^|[.-])staging([.-]|$)/i.test(location.hostname)) throw new Error('Open the target HTTPS staging CRM.');
    config.origin = location.origin;
  }
  if (location.origin !== config.origin || !document.querySelector('.shell .sidebar nav')) throw new Error('Open the authenticated target staging CRM first.');
  const results = [];
  let suiteRunning = false;
  const role = () => document.querySelector('#active-role')?.value ?? [...document.querySelectorAll('.sidebar .user .muted.small')].map(node => node.textContent.trim()).find(text => ['OWNER', 'ADMIN', 'PRODUCER', 'STAFF'].includes(text)) ?? 'unknown';
  const routeKind = () => /^\/accounts\/[^/]+\/?$/.test(location.pathname) ? 'account' : location.pathname.replace(/\/$/, '') || '/';
  const rowCount = () => document.querySelectorAll('main table tbody tr').length;
  const time = () => performance.now();
  const graphql = value => { try { const url = new URL(value, location.href); return url.protocol === 'https:' && url.pathname === '/graphql' && /\.appsync-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname); } catch { return false; } };
  const assets = () => performance.getEntriesByType('resource').filter(entry => /\/assets\/[^/]+\.js(?:\?|$)/.test(entry.name)).map(entry => new URL(entry.name).pathname).sort();
  const useful = flow => {
    const heading = document.querySelector('main h1')?.textContent.trim();
    if (flow === 'leads' || flow === 'clients') return heading === (flow === 'leads' ? 'Leads' : 'Clients') && !!document.querySelector('main table tbody tr.clickable');
    if (routeKind() !== 'account') return false;
    if (flow === 'overview') return !!document.querySelector('.account-overview [aria-label="Account details"]');
    if (flow === 'policies') return [...document.querySelectorAll('main h2')].some(node => node.textContent.trim() === 'Policies') && (!!document.querySelector('main table tbody tr') || [...document.querySelectorAll('main p')].some(node => node.textContent.includes('No policies.')));
    if (flow === 'documents') return !!document.querySelector('table[aria-label="Documents"] tbody tr') || [...document.querySelectorAll('.account-documents .documents-state')].some(node => node.textContent.trim() === 'No documents attached.');
    if (flow === 'activity') return !!document.querySelector('section[aria-label="Account communications"] .activity-history');
    return false;
  };
  function action(input) {
    if (input.kind === 'nav' && ['/leads', '/clients', '/carriers', '/settings'].includes(input.href)) {
      const anchor = [...document.querySelectorAll('.sidebar nav a')].find(node => new URL(node.href).pathname.replace(/\/$/, '') === input.href);
      if (!anchor) throw new Error('Requested sidebar navigation is unavailable.'); anchor.click(); return;
    }
    if (input.kind === 'tab' && ['Overview', 'Policies', 'Documents', 'Activity'].includes(input.label)) {
      const button = [...document.querySelectorAll('main > .tabs > button')].find(node => node.textContent.trim() === input.label);
      if (!button || button.disabled) throw new Error('Requested account tab is unavailable.'); button.click(); return;
    }
    if (input.kind === 'account' && typeof input.name === 'string') {
      const rows = [...document.querySelectorAll('main tr.clickable')].filter(node => node.querySelector('td:first-child strong')?.textContent.trim() === input.name);
      if (rows.length !== 1) throw new Error('The selected account must match exactly one visible row.'); rows[0].click(); return;
    }
    throw new Error('Only allowlisted read-only navigation actions are supported.');
  }
  async function measure(input) {
    if (location.origin !== config.origin || role() !== config.role) throw new Error('The staging origin or active role differs from the measurement configuration.');
    if (!['leads', 'clients', 'overview', 'policies', 'documents', 'activity'].includes(input.flow)) throw new Error('Choose a supported CRM flow.');
    if (window.__hoaCrmAuditActive) throw new Error('A flow measurement is already active.');
    window.__hoaCrmAuditActive = true;
    const started = time(), initialUseful = useful(input.flow), requests = [], original = window.fetch;
    const originRoute = routeKind(), resourceStart = performance.getEntriesByType('resource').length;
    let firstUseful, active = 0, lastNetwork = started, timer, observer, framePending = false, finished = false;
    const elapsed = value => Math.round((value - started) * 10) / 10;
    const inspect = () => {
      if (firstUseful !== undefined || framePending || !useful(input.flow)) return;
      framePending = true;
      requestAnimationFrame(() => { framePending = false; if (!finished && useful(input.flow)) firstUseful = time(); });
    };
    async function label(input, init) {
      try {
        const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
        const parsed = JSON.parse(body), operation = parsed.operationName ?? parsed.query?.match(/\b(query|mutation)\s+(\w+)/)?.[2] ?? 'GraphQL';
        const read = parsed.variables?.readOperation;
        return `${operation}${typeof read === 'string' && /^[A-Za-z]+$/.test(read) ? `:${read}` : ''}`;
      } catch { return 'GraphQL'; }
    }
    const wrapped = function(input, init) {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (!graphql(url)) return original.apply(this, arguments);
      const entry = { operation: 'GraphQL', startMs: elapsed(time()), endMs: null, bodyEndMs: null, jsonBytes: null, observerParseCpuMs: null, status: null, graphQLErrors: null, requestId: null };
      requests.push(entry); active++; lastNetwork = time();
      // Clone Request before fetch consumes its body. Never retain variables,
      // raw query bodies, authorization headers, or response contents.
      const request = input instanceof Request ? input.clone() : input;
      void label(request, init).then(value => { entry.operation = value; });
      const result = original.apply(this, arguments);
      void result.then(async response => {
        entry.status = response.status; entry.requestId = response.headers.get('x-amzn-requestid');
        const text = await response.clone().text(); entry.bodyEndMs = elapsed(time());
        const parseStarted = time(); entry.jsonBytes = new TextEncoder().encode(text).byteLength;
        try { entry.graphQLErrors = JSON.parse(text).errors?.length ?? 0; } catch { entry.graphQLErrors = null; }
        entry.observerParseCpuMs = Math.round((time() - parseStarted) * 100) / 100;
      }).catch(() => { entry.status ??= 'network-error'; }).finally(() => { entry.endMs = elapsed(time()); active--; lastNetwork = time(); });
      return result;
    };
    window.fetch = wrapped;
    const result = await new Promise(resolve => {
      const finish = status => {
        if (finished) return; finished = true; clearInterval(timer); observer.disconnect();
        if (window.fetch === wrapped) window.fetch = original; delete window.__hoaCrmAuditActive;
        const resources = performance.getEntriesByType('resource').slice(resourceStart).filter(entry => entry.startTime >= started && graphql(entry.name));
        const endpoints = [...new Set(resources.map(entry => new URL(entry.name).origin))].sort();
        const payloads = requests.filter(entry => entry.jsonBytes !== null);
        const fetchEnd = requests.map(entry => entry.bodyEndMs ?? entry.endMs).filter(value => value !== null);
        const resourceEnd = resources.map(entry => elapsed(entry.responseEnd));
        const report = { phase: config.phase, sample: input.sample ?? 1, flow: input.flow, cacheCondition: input.cacheCondition ?? 'operator-specified', role: role(),
          status, initialDomAlreadyUseful: initialUseful, firstUsefulDomFrameMs: firstUseful === undefined ? null : elapsed(firstUseful),
          lastGraphQLResponseMs: Math.max(0, ...fetchEnd, ...resourceEnd), graphQLFetchCount: requests.length, graphQLResourceCount: resources.length,
          requestsStartedBeforeFirstUseful: firstUseful === undefined ? null : requests.filter(entry => entry.startMs <= elapsed(firstUseful)).length,
          responseJsonBytes: payloads.length ? payloads.reduce((sum, entry) => sum + entry.jsonBytes, 0) : null,
          visibleRowsAtFinish: rowCount(), alertCount: document.querySelectorAll('main [role="alert"]').length,
          observerParseCpuMs: Math.round(requests.reduce((sum, entry) => sum + (entry.observerParseCpuMs ?? 0), 0) * 100) / 100,
          origin: config.origin, originRoute, destinationRoute: routeKind(), endpoints, assets: assets(), requests,
          method: 'Live authenticated browser; next animation frame after useful DOM; 750ms GraphQL quiet period; bounded20s; no credential/body retention. Resource timing may include CORS-preflight or lack protected sizes.' };
        resolve(report);
      };
      observer = new MutationObserver(inspect); observer.observe(document.querySelector('main') ?? document.body, { subtree: true, childList: true, characterData: true });
      timer = setInterval(() => {
        inspect();
        if (firstUseful !== undefined && active === 0 && time() - lastNetwork >= 750 && time() - firstUseful >= 250) finish('complete');
        else if (time() - started >= 20_000) finish('timeout');
      }, 50);
      try { action(input.action); inspect(); } catch { finish('action-unavailable'); }
    });
    results.push(result);
    const summary = { phase: result.phase, sample: result.sample, flow: result.flow, role: result.role, status: result.status,
      cache: result.cacheCondition, firstMs: result.firstUsefulDomFrameMs, lastApiMs: result.lastGraphQLResponseMs, fetches: result.graphQLFetchCount,
      resources: result.graphQLResourceCount, bytes: result.responseJsonBytes, rows: result.visibleRowsAtFinish, alerts: result.alertCount, observerCpuMs: result.observerParseCpuMs };
    console.log(`CRM_FLOW ${JSON.stringify(summary)}`); return result;
  }
  async function setupCarriers() {
    let active = 0, last = time();
    const started = time(), original = window.fetch;
    const wrapped = function(input) {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const result = original.apply(this, arguments);
      if (graphql(url)) { active++; last = time(); void result.finally(() => { active--; last = time(); }).catch(() => {}); }
      return result;
    };
    window.fetch = wrapped;
    try {
      action({ kind: 'nav', href: '/carriers' });
      while (time() - started < 20_000) {
        if (document.querySelector('main h1')?.textContent.trim() === 'Carriers' && active === 0 && time() - last >= 1000) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Carrier setup did not settle within20s.');
    } finally { if (window.fetch === wrapped) window.fetch = original; }
  }
  async function sampleSuite(input) {
    if (suiteRunning || window.__hoaCrmAuditActive) throw new Error('A measurement is already active.');
    if (typeof input.accountName !== 'string' || !input.accountName.trim() || !['leads', 'clients'].includes(input.accountList ?? 'clients')) throw new Error('Provide the fixed visible synthetic CLIENT name and accountList.');
    const repeats = input.repeats ?? 3, accountList = input.accountList ?? 'clients';
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('Use1–5 matched repetitions.');
    suiteRunning = true;
    if (input.clear !== false) results.length = 0;
    const run = async (flow, actionInput, sample, cacheCondition) => {
      const result = await measure({ flow, action: actionInput, sample, cacheCondition });
      if (result.status !== 'complete' || result.alertCount || result.requests.some(entry => entry.status !== 200 || entry.graphQLErrors)) throw new Error(`Stopped after ${flow}: unsuccessful flow or visible error.`);
    };
    try {
      for (let sample = 1; sample <= repeats; sample++) {
        await setupCarriers();
        const cache = sample === 1 ? 'first-suite-data-visit' : 'same-document-return';
        await run('leads', { kind: 'nav', href: '/leads' }, sample, cache);
        if (accountList === 'clients') await run('clients', { kind: 'nav', href: '/clients' }, sample, cache);
        await run('overview', { kind: 'account', name: input.accountName }, sample, cache);
        await run('policies', { kind: 'tab', label: 'Policies' }, sample, cache);
        await run('documents', { kind: 'tab', label: 'Documents' }, sample, cache);
        await run('activity', { kind: 'tab', label: 'Activity' }, sample, cache);
        if (accountList === 'leads') await run('clients', { kind: 'nav', href: '/clients' }, sample, cache);
      }
      await setupCarriers();
      await run('leads', { kind: 'nav', href: '/leads' }, repeats + 1, 'warm-return-after-suite');
      console.log(`CRM_SUITE ${JSON.stringify({ phase: config.phase, status: 'complete', reports: results.length, role: role() })}`);
    } catch (error) {
      console.log(`CRM_SUITE ${JSON.stringify({ phase: config.phase, status: 'stopped', reports: results.length, reason: error instanceof Error ? error.message : 'Measurement failed' })}`);
    } finally { suiteRunning = false; }
  }
  window.__hoaCrmAudit = { measure, sampleSuite, results, info: () => ({ ...config, role: role(), route: routeKind(), suiteRunning, reports: results.length, assets: assets() }),
    navigation: () => ({ phase: config.phase, role: role(), navigation: performance.getEntriesByType('navigation').map(entry => ({ type: entry.type, domContentLoadedMs: entry.domContentLoadedEventEnd, loadMs: entry.loadEventEnd })),
      paints: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, ms: entry.startTime })), graphQLResourceCount: performance.getEntriesByType('resource').filter(entry => graphql(entry.name)).length,
      lastGraphQLResponseMs: Math.max(0, ...performance.getEntriesByType('resource').filter(entry => graphql(entry.name)).map(entry => entry.responseEnd)), assets: assets() }) };
  return { installed: true, ...window.__hoaCrmAudit.info() };
}
const output = resolve(options.out);
writeFileSync(output, `(${install.toString()})(${JSON.stringify({ ...(origin ? { origin: origin.origin } : { currentStaging: true }), role: options.role, phase: options.phase })});\n`, { mode: 0o600 });
console.log(`Created read-only console helper: ${output}`);
