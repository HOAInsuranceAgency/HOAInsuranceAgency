import { CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { fileClient } from '../crm-access/file-signing';
import type { CommissionPolicy } from '../../../../shared/commissions';

const s3 = fileClient();

/** The account attachment may later be renamed, replaced or deleted. Keep the
 * exact confirmed object in the versioned private bucket before recording it. */
export async function retainIpfsEvidence(policyId: string, sourceKey: string, filename: string):
    Promise<NonNullable<CommissionPolicy['ipfsLegacyEvidence']>> {
  const source = process.env.DOCUMENT_BUCKET, destination = process.env.COMMISSION_BUCKET;
  if (!source || !destination) throw new Error('Private IPFS evidence storage is unavailable.');
  const original = await s3.send(new HeadObjectCommand({ Bucket: source, Key: sourceKey }));
  if (!original.ETag || !original.ContentLength || original.ContentLength > 100 * 1024 * 1024)
    throw new Error('The signed agreement file could not be verified.');
  const key = 'ipfs-evidence/' + createHash('sha256').update(JSON.stringify([policyId, sourceKey, original.ETag])).digest('hex');
  const archive = await s3.send(new CopyObjectCommand({
    Bucket: destination, Key: key, CopySource: [source, ...sourceKey.split('/')].map(encodeURIComponent).join('/'),
    CopySourceIfMatch: original.ETag, ChecksumAlgorithm: 'SHA256',
    MetadataDirective: 'REPLACE', ContentType: original.ContentType ?? 'application/octet-stream',
    TaggingDirective: 'REPLACE',
  }));
  const sha256 = archive.CopyObjectResult?.ChecksumSHA256;
  if (!archive.VersionId || archive.VersionId === 'null' || !sha256) throw new Error('The signed agreement version could not be retained.');
  return { key, versionId: archive.VersionId, filename, sha256 };
}
