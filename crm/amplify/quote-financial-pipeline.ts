import type { CfnFunctionConfiguration, CfnResolver } from 'aws-cdk-lib/aws-appsync';

export const QUOTE_FINANCIAL_STASH = 'serverCommittedFeeQuote';
export const QUOTE_FINANCIAL_RESPONSE = `#if($ctx.result.committed == true)\n$util.qr($ctx.stash.put("${QUOTE_FINANCIAL_STASH}", $ctx.result.quote))\n#end\n$util.toJson($ctx.prev.result)`;
/** Native auth remains before the financial transaction. Only the Lambda's
 * trusted response can populate this private stash; arguments are never copied. */
export function installQuoteFinancialStage(resolver: CfnResolver, data: CfnFunctionConfiguration, requestTemplate: string, guardId: string) {
  if (resolver.typeName !== 'Mutation' || resolver.fieldName !== 'updateQuote' || resolver.kind !== 'PIPELINE' || data.name !== 'MutationUpdateQuoteDataResolverFn') throw new Error('Invalid native financial Quote pipeline');
  const pipeline = resolver.pipelineConfig as CfnResolver.PipelineConfigProperty;
  const functions = [...pipeline.functions ?? []], position = functions.indexOf(data.attrFunctionId);
  if (position < 1 || functions.length >= 10) throw new Error('Native Quote authorization must precede the financial transaction');
  functions.splice(position, 0, guardId);
  resolver.pipelineConfig = { functions };
  data.requestMappingTemplate = `#if(!$util.isNull($ctx.stash.${QUOTE_FINANCIAL_STASH}))\n#return($ctx.stash.${QUOTE_FINANCIAL_STASH})\n#end\n${requestTemplate}`;
  data.requestMappingTemplateS3Location = undefined;
}
