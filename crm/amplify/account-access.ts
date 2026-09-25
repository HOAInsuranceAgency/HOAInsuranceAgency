import { readFileSync } from "node:fs";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Stack, CfnResource, AssetStaging } from "aws-cdk-lib";
import { CfnFunctionConfiguration, type CfnResolver } from "aws-cdk-lib/aws-appsync";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { backend as Backend } from "./backend";
import { ACCOUNT_MODELS, SHARED_MODELS, PUBLIC_OPERATIONS, ADMIN_OPERATIONS, CUSTOM_OPERATIONS, listPartition } from "./functions/crm-access/policy";

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
  guard.addEnvironment("ACCESS_API_ID", api.apiId);
  guard.addEnvironment("ACCESS_INDEXES", JSON.stringify(indexes));
  guard.addEnvironment("COMMUNICATION_TABLE", communicationTable.tableName);
  communicationTable.grantReadData(guard.resources.lambda);
  const tableArns = Object.values(tables).map(tableName => Stack.of(api).formatArn({ service: "dynamodb", resource: "table", resourceName: tableName }));
  guard.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], resources: [...tableArns, ...tableArns.map(arn => `${arn}/index/*`)] }));
  const bucket = backend.storage.resources.bucket;
  guard.addEnvironment("STORAGE_BUCKET", bucket.bucketName);
  bucket.grantReadWrite(guard.resources.lambda);
  bucket.grantDelete(guard.resources.lambda);
  const source = api.addLambdaDataSource("CrmAssignmentAccess", guard.resources.lambda);
  const guards = new Map<string, CfnFunctionConfiguration>();
  const makeGuard = (mode: string, model: string, field = "", operation = "") => {
    const key = `${mode}_${model}_${field}_${operation}`.replace(/-/g, "_");
    const cached = guards.get(key); if (cached) return cached.attrFunctionId;
    const fn = new CfnFunctionConfiguration(api, `Access_${key}`, {
      apiId: api.apiId, name: `access_${key}`, dataSourceName: source.name, functionVersion: "2018-05-29",
      requestMappingTemplate: `#if($util.authType() == "IAM Authorization")\n#if(!$util.isNull($ctx.identity.cognitoIdentityId))\n$util.unauthorized()\n#end\n#return($ctx.prev.result)\n#end\n${mode === "list" ? '#set($assignmentGroups = $util.defaultIfNull($ctx.identity.groups, $util.defaultIfNull($ctx.identity.claims.get("cognito:groups"), [])))\n#if($assignmentGroups.contains("ADMIN"))\n#return($ctx.prev.result)\n#end\n' : mode === "read" ? '#if(!$util.isNull($ctx.stash.assignmentList))\n#return($ctx.prev.result)\n#end\n' : ''}{"version":"2018-05-29","operation":"Invoke","payload":{"mode":"${mode}","model":"${model}","field":"${field}","operation":"${operation}","identity":$util.toJson($ctx.identity),"arguments":$util.toJson($ctx.arguments),"previous":$util.toJson($ctx.prev.result)}}`,
      responseMappingTemplate: `#if($ctx.error)\n$util.error($ctx.error.message, $ctx.error.type)\n#end\n${mode === "list" ? '$util.qr($ctx.stash.put("assignmentList", $ctx.result))\n' : ''}$util.toJson($ctx.result)`,
    });
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
  for (const resolver of Object.values(resources.cfnResolvers)) {
    const { typeName: type, fieldName: field } = resolver;
    const model = Object.entries(backend.data.resources.tables).find(([, table]) => resolver.requestMappingTemplate?.includes(`"tableName", "${table.tableName}"`))?.[0];
    if (model) {
      const scoped = (ACCOUNT_MODELS as readonly string[]).includes(model);
      if (type === "Mutation") {
        const operation = /^(create|update|delete)/.exec(field)?.[1];
        if (!operation) throw new Error(`Unclassified model mutation: ${field}`);
        if (scoped || model === "UserProfile") extend(resolver, [makeGuard("write", model, "", operation)], []);
      } else if (scoped) {
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
      const target = field.replace(/^on(Create|Update|Delete)/, "");
      if (!(SHARED_MODELS as readonly string[]).includes(target)) throw new Error(`Unsafe account subscription: ${field}`);
      continue;
    }
    if (PUBLIC_OPERATIONS.includes(field) || ADMIN_OPERATIONS.includes(field)) continue;
    if (CUSTOM_OPERATIONS.includes(field)) {
      if (!["crmAccess", "crmFile"].includes(field)) extend(resolver, [makeGuard("custom-pre", "", field)], field === "communicationRead" ? [makeGuard("custom-post", "", field)] : []);
      continue;
    }
    throw new Error(`Unclassified CRM resolver: ${type}.${field}`);
  }
}
