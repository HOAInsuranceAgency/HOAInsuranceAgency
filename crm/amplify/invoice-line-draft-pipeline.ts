import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetStaging } from 'aws-cdk-lib';
import type { CfnFunctionConfiguration, CfnResolver } from 'aws-cdk-lib/aws-appsync';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';

export const INVOICE_LINE_DRAFT_STASH = 'committedDraftLine';
export const INVOICE_LINE_DRAFT_RESPONSE = `#if($ctx.result.handled == true)
$util.qr($ctx.stash.put("${INVOICE_LINE_DRAFT_STASH}", $ctx.result.line))
#end
$util.toJson($ctx.prev.result)`;

/** The native authorizer still decides whether this model mutation is allowed. */
export function installInvoiceLineDraftStage(resolver: CfnResolver, data: CfnFunctionConfiguration, requestTemplate: string, guardId: string) {
  const field = resolver.fieldName;
  if (resolver.typeName !== 'Mutation' || resolver.kind !== 'PIPELINE' || !/^(create|update|delete)InvoiceLine$/.test(field) ||
      data.name !== `Mutation${field[0].toUpperCase()}${field.slice(1)}DataResolverFn`) {
    throw new Error('Invalid native InvoiceLine mutation pipeline');
  }
  const pipeline = resolver.pipelineConfig as CfnResolver.PipelineConfigProperty;
  const functions = [...pipeline.functions ?? []], position = functions.indexOf(data.attrFunctionId);
  if (position < 1 || functions.length >= 10) throw new Error('Native InvoiceLine authorization must precede the draft transaction');
  functions.splice(position, 0, guardId);
  resolver.pipelineConfig = { functions };
  const template = `#if(!$util.isNull($ctx.stash.${INVOICE_LINE_DRAFT_STASH}))
#return($ctx.stash.${INVOICE_LINE_DRAFT_STASH})
#end
${requestTemplate}`;
  // Keep the three rewritten native templates out of the nested data stack.
  const directory = mkdtempSync(join(tmpdir(), 'invoice-line-request-'));
  const path = join(directory, 'request.vtl');
  let stageUsesSource = false;
  try {
    writeFileSync(path, template);
    const asset = new Asset(data, 'DraftLineRequest', { path });
    stageUsesSource = (asset.node.findChild('Stage') as AssetStaging).absoluteStagedPath === path;
    data.requestMappingTemplate = undefined;
    data.requestMappingTemplateS3Location = asset.s3ObjectUrl;
  } finally {
    // An assembly with asset staging disabled still reads the original file.
    if (!stageUsesSource) rmSync(directory, { recursive: true, force: true });
  }
}
