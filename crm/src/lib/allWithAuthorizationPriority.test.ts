import { expect, it } from 'vitest';
import { allWithAuthorizationPriority } from './allWithAuthorizationPriority';

it('prioritizes a later access denial over an earlier transient failure in concurrent reads', async () => {
  let deny!: (reason: unknown) => void;
  const denied = Object.assign(new Error('Credentials changed'), { name: 'Unauthorized' });
  const result = allWithAuthorizationPriority([
    Promise.reject(new Error('Network timeout')),
    new Promise((_resolve, reject) => { deny = reject; }),
  ]);
  const assertion = expect(result).rejects.toBe(denied);
  await Promise.resolve();
  deny(denied);
  await assertion;
});

it('preserves transient failures and result positions without converting errors to missing data', async () => {
  const failure = new Error('Temporary report failure');
  await expect(allWithAuthorizationPriority([Promise.resolve([]), Promise.reject(failure)])).rejects.toBe(failure);
  await expect(allWithAuthorizationPriority([Promise.resolve('first'), Promise.resolve(2)])).resolves.toEqual(['first', 2]);
});
