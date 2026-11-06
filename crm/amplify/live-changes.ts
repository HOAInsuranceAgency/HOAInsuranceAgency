import { ManagedPolicy, PolicyStatement, type IRole } from 'aws-cdk-lib/aws-iam';
import { migrationTargets } from './migration-config';
import type { Construct } from 'constructs';
import type { backend as Backend } from './backend';

export const LIVE_PUBLISH_FIELDS = ['publishCrmChange', 'publishOwnerChange', 'publishPersonalChange'] as const;
export function grantLivePublish(scope: Construct, roles: IRole[], apiArn: string) {
  return new ManagedPolicy(scope, 'LiveChangePublish', {
    roles,
    statements: [new PolicyStatement({ actions: ['appsync:GraphQL'],
      resources: LIVE_PUBLISH_FIELDS.map(field => `${apiArn}/types/Mutation/fields/${field}`) })],
  });
}

/** No new data resources, schedules, or stream mappings. Keep this attachment
 * outside the generated data template and existing inline role budgets. */
export function livePublisherFunctions(backend: typeof Backend) {
  const functions = [backend.crmAccess, backend.activityLog, backend.honeycombWorker, backend.honeycombSubmissionWorker,
    backend.communications, backend.communicationWorker, backend.communicationWebhook, backend.communicationMonitor,
    backend.assignmentIndexWorker, backend.commissions, backend.brokerFees, backend.ownerProfitability,
    backend.stripeWebhook, backend.sendInvoice, backend.voidInvoice, backend.pfAdmin, backend.pfOriginate,
    backend.pfServicing, backend.pfDefaultSweep, backend.pfElection, backend.pfAutopay,
    backend.teamAdmin, backend.leadReply, backend.leadIntake,
    backend.portalSweep, backend.marketingReportApi,
    backend.marketingReportWorker];
  if ('sesMailFeedback' in backend) functions.push(backend.sesMailFeedback as typeof backend.crmAccess);
  return functions;
}
export function installLiveChanges(backend: typeof Backend) {
  // The retained namespace already pins its actual endpoint and verifies it
  // before deployment. Runtime helpers reuse its existing branch fence; no
  // new endpoint configuration or cross-stack data dependency is necessary.
  const target = migrationTargets.branches[process.env.AWS_BRANCH as keyof typeof migrationTargets.branches];
  if (!target) return;
  const api = backend.data.resources.graphqlApi;
  const functions = livePublisherFunctions(backend);
  grantLivePublish(backend.createStack('LiveChangePermissions'), functions.map(fn => fn.resources.lambda.role!), api.arn);
}
