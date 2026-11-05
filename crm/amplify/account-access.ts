import { installQuoteFinancialStage, QUOTE_FINANCIAL_RESPONSE } from "./quote-financial-pipeline";
import { readFileSync } from "node:fs";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Stack, CfnResource, AssetStaging } from "aws-cdk-lib";
import { CfnFunctionConfiguration, CfnResolver } from "aws-cdk-lib/aws-appsync";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { grantAccountTableReads } from "./account-access-policies";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { backend as Backend } from "./backend";
import { ACCOUNT_MODELS, SHARED_MODELS, PUBLIC_OPERATIONS, ADMIN_OPERATIONS, OWNER_OPERATIONS, ADMIN_MODEL_OPERATIONS, CUSTOM_OPERATIONS, listPartition } from "./functions/crm-access/policy";

// Only this post-commit stage is asynchronous. Authorization and financial
// stages must finish before the native write. Event invocation returns null;
// its response deliberately preserves the previous committed native result.
export const LIVE_NOTIFY_REQUEST = '{"version":"2018-05-29","operation":"Invoke","invocationType":"Event","payload":{"mode":"notify","previous":true}}';
export const LIVE_NOTIFY_RESPONSE = '$util.toJson($ctx.prev.result)';

/** Retain Amplify's native authorization and add current-assignment checks to
 * every generated entry point, including secondary indexes and relationships.
 * Classification is exhaustive: a newly introduced resolver fails synthesis
 * until its access policy is chosen explicitly. */
export function installAccountAccess(backend: typeof Backend, communicationTable: Table) {
  const api = backend.data.resources.graphqlApi, guard = backend.crmAccess;
  const resources = backend.data.resources.cfnResources;
  const tables: Record<string, string> = {};
  const indexes: Record<string, string> = {};
  const generated = backend.stack.node.root.node.findAll().filter((n): n is CfnResource => n instanceof CfnResource && n.cfnResourceType === "Custom::AmplifyDynamoDBTable");
  for (const model of Object.keys(resources.amplifyDynamoDbTables)) {
    if (![...ACCOUNT_MODELS, ...SHARED_MODELS].includes(model as never)) throw new Error(`Unclassified CRM model: ${model}`);
    const resource = generated.find(n => n.node.path.endsWith(`/${model}/${model}Table/Default/Default`));
    if (!resource) throw new Error(`Missing generated table for ${model}`);
    const template = Stack.of(resource).resolve(resource._toCloudFormation());
    type Index = { indexName: string; keySchema: { attributeName: string; keyType: string }[]; projection: { projectionType: string } };
    const properties = Object.values(template.Resources as Record<string, { Properties: { tableName: unknown; globalSecondaryIndexes?: Index[]; attributeDefinitions?: { attributeName: string; attributeType: string }[] } }>)[0].Properties;
    // Amplify names tables from the API ID. Verify the generated expression
    // before using it: a Ref to the nested table instead creates a cycle from
    // the model's resolver through this Lambda and back to the model stack.
    const name = `${model}-${api.apiId}-NONE`;
    if (JSON.stringify(properties.tableName) !== JSON.stringify(Stack.of(resource).resolve(name))) throw new Error(`Unexpected table name for ${model}; update the access map`);
    tables[model] = name;
    if ((ACCOUNT_MODELS as readonly string[]).includes(model) && !["Account", "GlApplication", "DoApplication"].includes(model)) {
      const all = [...properties.globalSecondaryIndexes ?? []], definitions = [...properties.attributeDefinitions ?? []];
      let added = 0;
      for (const field of model === "Document" ? ["entityId", "entityType"] : [listPartition(model)]) {
        let index = all.find(i => i.keySchema.length === 1 && i.keySchema[0].attributeName === field && i.projection.projectionType === "ALL");
        if (!index) {
          index = { indexName: `crmBy_${field}`, keySchema: [{ attributeName: field, keyType: "HASH" }], projection: { projectionType: "ALL" } };
          all.push(index); added++;
          if (!definitions.some(d => d.attributeName === field)) definitions.push({ attributeName: field, attributeType: "S" });
        }
        indexes[`${model}.${field}`] = index.indexName;
      }
      // DynamoDB supports adding one GSI to an existing table per deployment.
      if (added > 1) throw new Error(`Stage index additions for ${model} across deployments`);
      if (added) { resource.addPropertyOverride("globalSecondaryIndexes", all); resource.addPropertyOverride("attributeDefinitions", definitions); }
    }
  }
  backend.commissions.addEnvironment("COMMISSION_POLICY_ACCOUNT_INDEX", indexes["Policy.accountId"]);
  // Lead deletion checks must query the account partition, rather than mistake
  // an empty filtered scan page's continuation token for a related record.
  const deletionIndexes = ["Policy", "Invoice"].map(model => {
    const table = tables[model], index = indexes[`${model}.accountId`];
    if (!table || !index) throw new Error(`Missing ${model}.accountId index for lead deletion`);
    backend.communications.addEnvironment(`LEAD_DELETION_${model.toUpperCase()}_INDEX`, index);
    return `${Stack.of(api).formatArn({ service: "dynamodb", resource: "table", resourceName: table })}/index/${index}`;
  });
  backend.communications.resources.lambda.addToRolePolicy(new PolicyStatement({
    actions: ["dynamodb:Query"], resources: deletionIndexes,
  }));
  guard.addEnvironment("ACCESS_API_ID", api.apiId);
  guard.addEnvironment("ACCESS_INDEXES", JSON.stringify(indexes));
  backend.brokerFees.addEnvironment("ACCESS_INDEXES", JSON.stringify(indexes));
  backend.sendInvoice.addEnvironment("ACCESS_INDEXES", JSON.stringify(Object.fromEntries(["Invoice.accountId","InvoiceLine.invoiceId"].map(key=>[key,indexes[key]]))));
  guard.addEnvironment("COMMUNICATION_TABLE", communicationTable.tableName);
  communicationTable.grantReadData(guard.resources.lambda);
  const tableArns = Object.values(tables).map(tableName => Stack.of(api).formatArn({ service: "dynamodb", resource: "table", resourceName: tableName }));
  grantAccountTableReads(guard.resources.lambda, guard.resources.lambda.role!, tableArns);
  const bucket = backend.storage.resources.bucket;
  guard.addEnvironment("STORAGE_BUCKET", bucket.bucketName);
  bucket.grantReadWrite(guard.resources.lambda);
  bucket.grantDelete(guard.resources.lambda);
  const source = api.addLambdaDataSource("CrmAssignmentAccess", guard.resources.lambda);
  const guards = new Map<string, CfnFunctionConfiguration>();
  // Custom operations share a guard; AppSync supplies the actual schema field
  // for each invocation (including aliased queries). Avoid one otherwise
  // identical CloudFormation resource per custom operation.
  const makeGuard = (mode: string, model: string, operation = "") => {
    const key = `${mode}_${model}__${operation}`.replace(/-/g, "_");
    const cached = guards.get(key); if (cached) return cached.attrFunctionId;
    const listAdminBypass = '#set($assignmentGroups = $util.defaultIfNull($ctx.identity.groups, $util.defaultIfNull($ctx.identity.claims.get("cognito:groups"), [])))\n'
      + '#set($assignmentRole = "")\n#set($assignmentRoleCount = 0)\n#foreach($header in $ctx.request.headers.entrySet())\n#if($header.key.toLowerCase() == "x-crm-role")\n#set($assignmentRole = $header.value)\n#set($assignmentRoleCount = $assignmentRoleCount + 1)\n#end\n#end\n'
      + '#if(($assignmentRoleCount == 0 && ($assignmentGroups.contains("OWNER") || $assignmentGroups.contains("ADMIN"))) || ($assignmentRoleCount == 1 && (($assignmentRole == "OWNER" && $assignmentGroups.contains("OWNER")) || ($assignmentRole == "ADMIN" && $assignmentGroups.contains("ADMIN")))))\n#return($ctx.prev.result)\n#end\n';
    const fn = new CfnFunctionConfiguration(api, `Access_${key}`, {
      apiId: api.apiId, name: `access_${key}`, dataSourceName: source.name, functionVersion: "2018-05-29",
      requestMappingTemplate: mode === 'notify' ? LIVE_NOTIFY_REQUEST : `#if($util.authType() == "IAM Authorization")\n#if(!$util.isNull($ctx.identity.cognitoIdentityId))\n$util.unauthorized()\n#end\n#return($ctx.prev.result)\n#end\n${mode === "list" ? listAdminBypass : mode === "read" ? '#if(!$util.isNull($ctx.stash.assignmentList))\n#return($ctx.prev.result)\n#end\n' : ''}{"version":"2018-05-29","operation":"Invoke","payload":{"mode":"${mode}","model":"${model}","field":$util.toJson($ctx.info.fieldName),"operation":"${operation}","identity":$util.toJson($ctx.identity),"request":$util.toJson($ctx.request),"arguments":$util.toJson($ctx.arguments),"previous":$util.toJson($ctx.prev.result)${mode === "quote-financial" ? ',"nativeConditions":$util.toJson($ctx.stash.conditions),"nativeAuthFilter":$util.toJson($ctx.stash.authFilter)' : ''}}}`,
      responseMappingTemplate: mode === 'notify' ? LIVE_NOTIFY_RESPONSE : `#if($ctx.error)\n$util.error($ctx.error.message, $ctx.error.type)\n#end\n${mode === "list" ? '$util.qr($ctx.stash.put("assignmentList", $ctx.result))\n' : ''}${mode === "quote-financial" ? QUOTE_FINANCIAL_RESPONSE : '$util.toJson($ctx.result)'}`,
    });
    // CDK's diagnostic construct paths duplicate these already descriptive
    // access_* names. Omit only that metadata to keep the staging data template
    // below CloudFormation's limit; all resource properties and checks remain.
    fn.addDeletionOverride("Metadata.aws:cdk:path");
    // This new shared ID appears in every mutation pipeline. A short stable
    // logical ID saves several KB without renaming any existing resource.
    if (mode === 'notify') fn.overrideLogicalId('LiveNotify');
    fn.addResourceDependency(source.node.defaultChild as import("aws-cdk-lib/aws-appsync").CfnDataSource);
    guards.set(key, fn); return fn.attrFunctionId;
  };
  function extend(resolver: CfnResolver, before: string[], after: string[]) {
    if (resolver.kind !== "PIPELINE") throw new Error(`CRM access requires a pipeline: ${resolver.typeName}.${resolver.fieldName}`);
    const pipeline = resolver.pipelineConfig as CfnResolver.PipelineConfigProperty;
    const functions = [...before, ...(pipeline.functions ?? []), ...after];
    if (functions.length > 10) throw new Error(`Too many pipeline stages for ${resolver.fieldName}`);
    resolver.pipelineConfig = { functions };
  }
  function prependResponse(resolver: CfnResolver, prefix: string) {
    let template = resolver.responseMappingTemplate;
    if (resolver.responseMappingTemplateS3Location) {
      const location = JSON.stringify(Stack.of(resolver).resolve(resolver.responseMappingTemplateS3Location));
      const asset = backend.stack.node.root.node.findAll().find((node): node is Asset =>
        node instanceof Asset && JSON.stringify(Stack.of(resolver).resolve(node.s3ObjectUrl)) === location);
      if (!asset) throw new Error(`Missing generated response template for ${resolver.fieldName}`);
      template = readFileSync((asset.node.findChild("Stage") as AssetStaging).absoluteStagedPath, "utf8");
    }
    if (!template) throw new Error(`Empty generated response template for ${resolver.fieldName}`);
    // Preserve Amplify's response while replacing its asset reference with one
    // inline template. AppSync rejects a resolver that specifies both.
    resolver.responseMappingTemplate = prefix + template;
    resolver.responseMappingTemplateS3Location = undefined;
  }
  // Amplify's custom JS pipelines are not included in cfnResolvers. Include
  // their actual constructs so they receive the same persistent session gate.
  const resolvers = backend.stack.node.root.node.findAll().filter((node): node is CfnResolver => node instanceof CfnResolver);
  const liveFields = ['publishCrmChange', 'publishOwnerChange', 'publishPersonalChange', 'onCrmChange', 'onOwnerChange', 'onPersonalChange'];
  const liveFunctions = backend.stack.node.root.node.findAll().filter((node): node is CfnFunctionConfiguration =>
    node instanceof CfnFunctionConfiguration && liveFields.some(field => node.name === `Fn_${field.startsWith('on') ? 'Subscription' : 'Mutation'}_${field}_1`));
  const none = Object.values(resources.cfnDataSources).find(source => source.name === 'NONE_DS');
  if (liveFunctions.length !== 6 || !none) throw new Error('Missing generated live-change JS handlers or NONE data source');
  for (const fn of liveFunctions) {
    // Gen2 depends on the entire API construct, expanding into >1,600 IDs for
    // EACH function/resolver. The exact datasource and existing ApiId reference
    // provide the real dependencies without exceeding CloudFormation's limit.
    fn.node.removeDependency(...fn.node.dependencies);
    fn.addResourceDependency(none);
  }
  for (const resolver of resolvers) {
    const { typeName: type, fieldName: field } = resolver;
    if (liveFields.includes(field)) {
      resolver.node.removeDependency(...resolver.node.dependencies);
      resolver.addResourceDependency(resources.cfnGraphqlSchema);
      // Keep the original JS handler functions; use the ordinary VTL pipeline
      // shell so the existing session stage and revocation response can run.
      resolver.code = undefined; resolver.codeS3Location = undefined; resolver.runtime = undefined;
      resolver.requestMappingTemplate = '{}';
      resolver.responseMappingTemplate = '$util.toJson($ctx.prev.result)';
    }
    const model = Object.entries(backend.data.resources.tables).find(([, table]) => resolver.requestMappingTemplate?.includes(`"tableName", "${table.tableName}"`))?.[0];
    if (model) {
      const scoped = (ACCOUNT_MODELS as readonly string[]).includes(model);
      if (type === "Mutation") {
        const operation = /^(create|update|delete)/.exec(field)?.[1];
        if (!operation) throw new Error(`Unclassified model mutation: ${field}`);
        if (ADMIN_MODEL_OPERATIONS[model]?.includes(operation)) extend(resolver, [makeGuard("admin", "")], []);
        if (scoped || model === "UserProfile") extend(resolver, [makeGuard("write", model, operation)], []);
        if (model === "Quote" && operation === "update") {
          const pipeline = resolver.pipelineConfig as CfnResolver.PipelineConfigProperty;
          const data = Object.values(resources.cfnFunctionConfigurations).find(fn => pipeline.functions?.includes(fn.attrFunctionId) && fn.name === 'MutationUpdateQuoteDataResolverFn');
          if (!data) throw new Error('Missing native Quote update data stage');
          let template = data.requestMappingTemplate;
          if (data.requestMappingTemplateS3Location) {
            const location = JSON.stringify(Stack.of(data).resolve(data.requestMappingTemplateS3Location));
            const asset = backend.stack.node.root.node.findAll().find((node): node is Asset => node instanceof Asset && JSON.stringify(Stack.of(data).resolve(node.s3ObjectUrl)) === location);
            if (!asset) throw new Error('Missing native Quote update request template');
            template = readFileSync((asset.node.findChild('Stage') as AssetStaging).absoluteStagedPath, 'utf8');
          }
          if (!template) throw new Error('Empty native Quote update request template');
          installQuoteFinancialStage(resolver, data, template, makeGuard('quote-financial', 'Quote', 'update'));
        }
        // One shared, post-success stage covers unstreamed model writes too.
        // The native result is preserved; notification errors cannot retry a write.
        extend(resolver, [], [makeGuard('notify', '')]);
      } else if (scoped) {
        if (ADMIN_MODEL_OPERATIONS[model]?.includes("read")) extend(resolver, [makeGuard("admin", "")], []);
        const pipeline = resolver.pipelineConfig as CfnResolver.PipelineConfigProperty;
        const data = Object.values(resources.cfnFunctionConfigurations).find(fn => pipeline.functions?.includes(fn.attrFunctionId) && fn.name === `${type}${field[0].toUpperCase()}${field.slice(1)}DataResolverFn`);
        let template = data?.requestMappingTemplate;
        if (type === "Query" && data?.requestMappingTemplateS3Location) {
          const location = JSON.stringify(Stack.of(data).resolve(data.requestMappingTemplateS3Location));
          const asset = data.node.scope!.node.findAll().find((node): node is Asset => node instanceof Asset && JSON.stringify(Stack.of(data).resolve(node.s3ObjectUrl)) === location);
          if (!asset) throw new Error(`Missing generated request template for ${field}`);
          template = readFileSync((asset.node.findChild("Stage") as AssetStaging).absoluteStagedPath, "utf8");
        }
        if (type === "Query" && data && template?.includes('"Scan"')) {
          const functions = [...pipeline.functions ?? []], position = functions.indexOf(data.attrFunctionId);
          // Run after Amplify's authorization stages; only replace the scan.
          functions.splice(position, 0, makeGuard("list", model)); resolver.pipelineConfig = { functions };
          data.requestMappingTemplate = '#if(!$util.isNull($ctx.stash.assignmentList))\n#return($ctx.stash.assignmentList)\n#end\n' + template;
          data.requestMappingTemplateS3Location = undefined;
        }
        extend(resolver, [], [makeGuard("read", model)]);
      }
      continue;
    }
    if (type === "Subscription") {
      if (["onCrmChange", "onOwnerChange", "onPersonalChange"].includes(field)) {
        continue;
      }
      const target = field.replace(/^on(Create|Update|Delete)/, "");
      if (target !== "AgencySettings") throw new Error(`Unsafe account subscription: ${field}`);
      // There are only three supported broadcasts. Each connection records
      // its authenticated user so an Owner can close it on deactivation.
      prependResponse(resolver, '#if(!$util.isNull($ctx.identity.sub))\n$extensions.setSubscriptionInvalidationFilter({"filterGroup":[{"filters":[{"fieldName":"userId","operator":"eq","value":$ctx.identity.sub}]}]})\n#end\n');
      continue;
    }
    if (["publishCrmChange", "publishOwnerChange", "publishPersonalChange"].includes(field)) continue;
    if (PUBLIC_OPERATIONS.includes(field)) continue;
    if (OWNER_OPERATIONS.includes(field)) {
      extend(resolver, [makeGuard("owner", "")], []);
      continue;
    }
    if (ADMIN_OPERATIONS.includes(field)) {
      extend(resolver, [makeGuard("admin", "")], []);
      continue;
    }
    if (CUSTOM_OPERATIONS.includes(field)) {
      if (!["crmAccess", "crmFile"].includes(field)) extend(resolver, [makeGuard("custom-pre", "")], field === "communicationRead" ? [makeGuard("custom-post", "")] : []);
      continue;
    }
    throw new Error(`Unclassified CRM resolver: ${type}.${field}`);
  }
  // Apply this last so it is always first, even before active-role guards and
  // native model reads. This covers shared data, indexes, relationships,
  // subscriptions, custom functions, and file signing. Trusted server IAM
  // retains its existing bypass; identity-pool browser IAM is still rejected.
  const session = makeGuard("session", "");
  for (const resolver of resolvers) {
    if (!PUBLIC_OPERATIONS.includes(resolver.fieldName)) extend(resolver, [session], []);
    if (resolver.fieldName === "setTeamUserEnabled") {
      const invalidate = ["onCreateAgencySettings", "onUpdateAgencySettings", "onDeleteAgencySettings", "onCrmChange", "onOwnerChange", "onPersonalChange"].map(subscriptionField =>
        `$extensions.invalidateSubscriptions({"subscriptionField":"${subscriptionField}","payload":{"userId":$ctx.prev.result.userId}})`).join("\n");
      // Close broadcasts even when a committed denial's response was lost.
      // Only an authorized attempt with a verified, non-self target returns
      // userId; on a failed write an active user can safely reconnect.
      prependResponse(resolver, `#if($ctx.arguments.enabled == false && !$util.isNull($ctx.prev.result.userId))\n${invalidate}\n#end\n`);
    }
  }
}
