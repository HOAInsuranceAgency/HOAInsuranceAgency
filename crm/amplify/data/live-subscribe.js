import { util, extensions } from '@aws-appsync/utils';

export function request() { return { payload: null }; }
export function response(ctx) {
  const identity = ctx.identity;
  if (!identity || !identity.sub) util.unauthorized();
  const claims = identity.claims || {};
  const rawGroups = identity.groups || claims['cognito:groups'];
  const groups = Array.isArray(rawGroups) ? rawGroups : [];
  const roles = ['OWNER', 'ADMIN', 'STAFF', 'PRODUCER'];
  let role = '';
  let selected = 0;
  for (const key of Object.keys(ctx.request.headers)) {
    if (key.toLowerCase() === 'x-crm-role') { role = ctx.request.headers[key]; selected += 1; }
  }
  if (selected > 1) util.unauthorized();
  if (selected === 0) {
    for (const candidate of roles) { if (!role && groups.includes(candidate)) role = candidate; }
  }
  // Existing legacy accounts have no group claim and intentionally use the
  // unasserted STAFF view. They still receive assignment-filtered reads.
  const legacyStaff = selected === 0 && !role;
  if (legacyStaff) role = 'STAFF';
  if (!legacyStaff && (!roles.includes(role) || !groups.includes(role))) util.unauthorized();
  if (ctx.info.fieldName === 'onOwnerChange' && role !== 'OWNER') util.unauthorized();
  if (ctx.info.fieldName === 'onPersonalChange') {
    extensions.setSubscriptionFilter(util.transform.toSubscriptionFilter({ userId: { eq: identity.sub } }));
  }
  extensions.setSubscriptionInvalidationFilter({ filterGroup: [{ filters: [{ fieldName: 'userId', operator: 'eq', value: identity.sub }] }] });
  return null;
}
