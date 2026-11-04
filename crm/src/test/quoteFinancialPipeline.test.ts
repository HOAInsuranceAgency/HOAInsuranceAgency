// @vitest-environment node
import { App, Stack } from 'aws-cdk-lib';
import { CfnFunctionConfiguration, CfnResolver } from 'aws-cdk-lib/aws-appsync';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { installQuoteFinancialStage, QUOTE_FINANCIAL_RESPONSE, QUOTE_FINANCIAL_STASH } from '../../amplify/quote-financial-pipeline';

it('retains native authorization before the atomic commit and skips only a server-stashed write', () => {
  const stack = new Stack(new App(), 'QuotePipeline');
  const fn = (name:string, request:string) => new CfnFunctionConfiguration(stack,name,{apiId:'api',name,dataSourceName:'data',functionVersion:'2018-05-29',requestMappingTemplate:request,responseMappingTemplate:'$util.toJson($ctx.result)'});
  const auth=fn('MutationupdateQuoteauth0Function','$util.unauthorized()'),postAuth=fn('MutationupdateQuotepostAuth0Function','{}');
  const data=fn('MutationUpdateQuoteDataResolverFn','{"operation":"UpdateItem"}');
  data.requestMappingTemplate=undefined;data.requestMappingTemplateS3Location='s3://original/request.vtl';
  const commit=fn('AtomicQuoteCommit','{"mode":"quote-financial","field":$util.toJson($ctx.info.fieldName)}');commit.responseMappingTemplate=QUOTE_FINANCIAL_RESPONSE;
  const resolver=new CfnResolver(stack,'UpdateQuote',{apiId:'api',typeName:'Mutation',fieldName:'updateQuote',kind:'PIPELINE',pipelineConfig:{functions:[auth.attrFunctionId,postAuth.attrFunctionId,data.attrFunctionId]},requestMappingTemplate:'{}',responseMappingTemplate:'$util.toJson($ctx.prev.result)'});
  installQuoteFinancialStage(resolver,data,'{"operation":"UpdateItem","key":$util.toJson($ctx.arguments.input.id)}',commit.attrFunctionId);
  const template=Template.fromStack(stack);
  const pipeline=Object.values(template.findResources('AWS::AppSync::Resolver'))[0].Properties.PipelineConfig.Functions;
  expect(pipeline).toEqual([auth,postAuth,commit,data].map(item=>stack.resolve(item.attrFunctionId)));
  const functions=Object.values(template.findResources('AWS::AppSync::FunctionConfiguration')).map(row=>row.Properties);
  const native=functions.find(row=>row.Name==='MutationUpdateQuoteDataResolverFn')!;
  expect(native.RequestMappingTemplate).toBe(`#if(!$util.isNull($ctx.stash.${QUOTE_FINANCIAL_STASH}))\n#return($ctx.stash.${QUOTE_FINANCIAL_STASH})\n#end\n{"operation":"UpdateItem","key":$util.toJson($ctx.arguments.input.id)}`);
  expect(native).not.toHaveProperty('RequestMappingTemplateS3Location');
  expect(QUOTE_FINANCIAL_RESPONSE).toContain(`$ctx.stash.put("${QUOTE_FINANCIAL_STASH}", $ctx.result.quote)`);
  expect(QUOTE_FINANCIAL_RESPONSE).not.toContain('$ctx.arguments');
  expect(QUOTE_FINANCIAL_RESPONSE).toContain('$ctx.result.committed == true');
});
