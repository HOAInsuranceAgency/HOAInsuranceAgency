import { getCurrentUser } from 'aws-amplify/auth';
/** Navigation preferences only; financial drafts remain private server records. */
export async function getCommissionStorageKey() {
  const user = await getCurrentUser();
  return 'hoa-commission-navigation:' + user.userId + ':owner';
}
