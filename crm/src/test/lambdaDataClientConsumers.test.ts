// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ config: vi.fn(), configure: vi.fn(), generate: vi.fn(), reply: vi.fn(), presign: vi.fn() }));
vi.mock('@aws-amplify/backend/function/runtime', () => ({ getAmplifyDataClientConfig: m.config }));
vi.mock('aws-amplify', () => ({ Amplify: { configure: m.configure } }));
vi.mock('aws-amplify/data', () => ({ generateClient: m.generate }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: m.presign }));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  m.config.mockResolvedValue({ resourceConfig: {}, libraryOptions: {} });
  m.reply.mockResolvedValue({ data: [] });
});
const event = { arguments: { uploadToken: 'closed-fictional-upload-token-123456', filename: 'scan.pdf', sizeBytes: 20 } };

it('imports real consumers without configuring, then keeps their lazy caches separate', async () => {
  const communications = await import('../../amplify/functions/communications/data');
  const upload = await import('../../amplify/functions/lead-upload/handler');
  expect(m.config).not.toHaveBeenCalled();
  expect(m.configure).not.toHaveBeenCalled();
  const a = { models: {} }, b = { models: { LeadReply: { listLeadReplyByUploadToken: m.reply } } };
  m.generate.mockReturnValueOnce(a).mockReturnValueOnce(b);
  expect(await communications.dataClient()).toBe(a);
  expect(await upload.handler(event)).toEqual({ ok: false, error: 'That upload link is no longer active.' });
  expect(await communications.dataClient()).toBe(a);
  await upload.handler(event);
  expect(m.config).toHaveBeenCalledTimes(2);
  expect(m.generate).toHaveBeenCalledTimes(2);
  expect(m.reply).toHaveBeenCalledTimes(2);
  expect(m.presign).not.toHaveBeenCalled();
});

it('allows a real public handler to recover from failed initialization without signing or writing', async () => {
  const upload = await import('../../amplify/functions/lead-upload/handler');
  m.config.mockRejectedValueOnce(new Error('Configuration unavailable'));
  m.generate.mockReturnValue({ models: { LeadReply: { listLeadReplyByUploadToken: m.reply } } });
  await expect(upload.handler(event)).rejects.toThrow('Configuration unavailable');
  expect(m.reply).not.toHaveBeenCalled();
  expect(await upload.handler(event)).toEqual({ ok: false, error: 'That upload link is no longer active.' });
  expect(m.config).toHaveBeenCalledTimes(2);
  expect(m.generate).toHaveBeenCalledOnce();
  expect(m.reply).toHaveBeenCalledOnce();
  expect(m.presign).not.toHaveBeenCalled();
});
