/** An Owner identifies the signed external agreement among documents already attached to this term. */
export function isIpfsEvidenceDocument(doc: {
  id?: unknown; entityType?: unknown; entityId?: unknown; policyId?: unknown; quoteId?: unknown;
  policyIds?: unknown; quoteIds?: unknown; category?: unknown; s3Key?: unknown;
}, policy: { id: string; accountId: string; quoteId: string }) {
  const account = doc.entityType === 'ACCOUNT' && doc.entityId === policy.accountId;
  return account && typeof doc.id === 'string' && typeof doc.s3Key === 'string' &&
    doc.s3Key.startsWith(`documents/ACCOUNT/${policy.accountId}/`) &&
    ['OTHER', 'QUOTE_DOC', 'POLICY_DOC'].includes(String(doc.category)) &&
    (doc.policyId === policy.id || doc.quoteId === policy.quoteId ||
      Array.isArray(doc.policyIds) && doc.policyIds.includes(policy.id) ||
      Array.isArray(doc.quoteIds) && doc.quoteIds.includes(policy.quoteId));
}
