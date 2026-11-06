import { util } from '@aws-appsync/utils';

export function request(ctx) {
  // User pools and Cognito identity-pool IAM cannot publish, even if a future
  // schema rule accidentally grants the field. Only signed service IAM remains.
  if (!ctx.identity || !ctx.identity.userArn || ctx.identity.sub || ctx.identity.cognitoIdentityId || ctx.identity.cognitoIdentityPoolId) util.unauthorized();
  return { payload: null };
}
export function response(ctx) {
  const revision = util.autoId();
  if (ctx.info.fieldName === 'publishPersonalChange') {
    const userId = ctx.args.userId;
    if (typeof userId !== 'string' || !userId || userId.length > 128) util.unauthorized();
    return { revision, userId };
  }
  return { revision };
}
