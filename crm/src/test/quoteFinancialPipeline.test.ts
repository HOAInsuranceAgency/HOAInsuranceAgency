// @vitest-environment node
import { readFileSync } from 'node:fs';
import { App, Stack, type AssetStaging } from 'aws-cdk-lib';
import { CfnFunctionConfiguration, CfnResolver } from 'aws-cdk-lib/aws-appsync';
import { Template } from 'aws-cdk-lib/assertions';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { expect, it } from 'vitest';
import { installQuoteFinancialStage, QUOTE_FINANCIAL_RESPONSE, QUOTE_FINANCIAL_STASH } from '../../amplify/quote-financial-pipeline';
import { installInvoiceLineDraftStage, INVOICE_LINE_DRAFT_RESPONSE, INVOICE_LINE_DRAFT_STASH } from '../../amplify/invoice-line-draft-pipeline';

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

it('installs one shared draft line guard after native authorization for create, update, and delete', () => {
  const stack = new Stack(new App(), 'InvoiceLinePipeline');
  const fn = (name: string, response = '$util.toJson($ctx.result)') => new CfnFunctionConfiguration(stack, name, {
    apiId: 'api', name, dataSourceName: 'data', functionVersion: '2018-05-29', requestMappingTemplate: '{}', responseMappingTemplate: response,
  });
  const auth = fn('NativeAuth'), postAuth = fn('NativePostAuth'), commit = fn('SharedDraftLineCommit', INVOICE_LINE_DRAFT_RESPONSE);
  for (const operation of ['Create', 'Update', 'Delete']) {
    const fieldName = `${operation.toLowerCase()}InvoiceLine`;
    const data = fn(`Mutation${operation}InvoiceLineDataResolverFn`);
    data.requestMappingTemplate = undefined;
    data.requestMappingTemplateS3Location = 's3://original/request.vtl';
    const resolver = new CfnResolver(stack, fieldName, {
      apiId: 'api', typeName: 'Mutation', fieldName, kind: 'PIPELINE',
      pipelineConfig: { functions: [auth.attrFunctionId, postAuth.attrFunctionId, data.attrFunctionId] },
      requestMappingTemplate: '{}', responseMappingTemplate: '$util.toJson($ctx.prev.result)',
    });
    const native = `{"operation":"${operation === 'Create' ? 'Put' : operation}Item"}`;
    installInvoiceLineDraftStage(resolver, data, native, commit.attrFunctionId);
    expect(resolver.pipelineConfig).toEqual({ functions: [auth, postAuth, commit, data].map(item => item.attrFunctionId) });
    const asset = data.node.findChild('DraftLineRequest') as Asset;
    expect(data.requestMappingTemplate).toBeUndefined();
    expect(data.requestMappingTemplateS3Location).toBe(asset.s3ObjectUrl);
    const staged = asset.node.findChild('Stage') as AssetStaging;
    expect(readFileSync(staged.absoluteStagedPath, 'utf8')).toBe(`#if(!$util.isNull($ctx.stash.${INVOICE_LINE_DRAFT_STASH}))\n#return($ctx.stash.${INVOICE_LINE_DRAFT_STASH})\n#end\n${native}`);
  }
  expect(INVOICE_LINE_DRAFT_RESPONSE).toContain('$ctx.result.handled == true');
  expect(INVOICE_LINE_DRAFT_RESPONSE).toContain(`$ctx.stash.put("${INVOICE_LINE_DRAFT_STASH}", $ctx.result.line)`);
  expect(INVOICE_LINE_DRAFT_RESPONSE).not.toContain('$ctx.arguments');
});
