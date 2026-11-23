import { beforeEach, expect, it, vi } from 'vitest';
const s3 = vi.hoisted(() => vi.fn());
vi.mock('../../amplify/functions/crm-access/file-signing', () => ({ fileClient: () => ({send:s3}) }));
import { retainIpfsEvidence } from '../../amplify/functions/commissions/ipfs-evidence';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DOCUMENT_BUCKET','account-documents');
  vi.stubEnv('COMMISSION_BUCKET','private-evidence');
});
it('freezes the exact signed bytes, archive version and checksum independently of the editable account attachment', async () => {
  s3.mockResolvedValueOnce({ETag:'"original"',ContentLength:1234,ContentType:'application/pdf'})
    .mockResolvedValueOnce({VersionId:'v1',CopyObjectResult:{ChecksumSHA256:'checksum'}});
  const archive = await retainIpfsEvidence('policy','documents/ACCOUNT/account/doc/Signed #1.pdf','Signed #1.pdf');
  expect(s3.mock.calls[1][0].input).toMatchObject({ Bucket:'private-evidence', CopySource:'account-documents/documents/ACCOUNT/account/doc/Signed%20%231.pdf',
    CopySourceIfMatch:'"original"',ChecksumAlgorithm:'SHA256',Key:archive.key });
  expect(archive).toEqual({ key:expect.stringMatching(/^ipfs-evidence\/[a-f0-9]{64}$/), filename:'Signed #1.pdf',versionId:'v1',sha256:'checksum' });
});
it('rejects a source replacement or an unversioned custody copy', async () => {
  s3.mockResolvedValueOnce({ETag:'"old"',ContentLength:1}).mockRejectedValueOnce(new Error('PreconditionFailed'));
  await expect(retainIpfsEvidence('p','key','Signed')).rejects.toThrow(/Precondition/);
  s3.mockResolvedValueOnce({ETag:'"new"',ContentLength:1}).mockResolvedValueOnce({CopyObjectResult:{ChecksumSHA256:'sha'}});
  await expect(retainIpfsEvidence('p','key','Signed')).rejects.toThrow(/version/);
});
