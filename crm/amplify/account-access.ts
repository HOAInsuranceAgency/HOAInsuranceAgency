import { Stack, CfnResource } from "aws-cdk-lib";
import { CfnFunctionConfiguration, type CfnResolver } from "aws-cdk-lib/aws-appsync";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { backend as Backend } from "./backend";
import { ACCOUNT_MODELS, SHARED_MODELS, PUBLIC_OPERATIONS, ADMIN_OPERATIONS, CUSTOM_OPERATIONS } from "./functions/crm-access/policy";

/** Retain Amplify's native authorization and add current-assignment checks to
 * every generated entry point, including secondary indexes and relationships.
 * Classification is exhaustive: a newly introduced resolver fails synthesis
 * until its access policy is chosen explicitly. */
export function installAccountAccess(backend: typeof Backend, communicationTable: Table) {
  const api = backend.data.resources.graphqlApi, guard = backend.crmAccess;
  const resources = backend.data.resources.cfnResources;
  const tables: Record<string, string> = {};
  const generated = backend.stack.node.root.node.findAll().filter((n): n is CfnResource => n instanceof CfnResource && n.cfnResourceType === "Custom::AmplifyDynamoDBTable");
  for (const model of Object.keys(resources.amplifyDynamoDbTables)) {
    if (![...ACCOUNT_MODELS, ...SHARED_MODELS].includes(model as never)) throw new Error(`Unclassified CRM model: ${model}`);
    const resource = generated.find(n => n.node.path.endsWith(`/${model}/${model}Table/Default/Default`));
    if (!resource) throw new Error(`Missing generated table for ${model}`);
    const template = Stack.of(resource).resolve(resource._toCloudFormation());
    const properties = Object.values(template.Resources as Record<string, { Properties: { tableName: unknown } }>)[0].Properties;
    // Amplify names tables from the API ID. Verify the generated expression
    // before using it: a Ref to the nested table instead creates a cycle from
    // the model's resolver through this Lambda and back to the model stack.
    const name = `${model}-${api.apiId}-NONE`;
    if (JSON.stringify(properties.tableName) !== JSON.stringify(Stack.of(resource).resolve(name))) throw new Error(`Unexpected table name for ${model}; update the access map`);
    tables[model] = name;
  }
  guard.addEnvironment("ACCESS_TABLES", JSON.stringify(tables));
  guard.addEnvironment("COMMUNICATION_TABLE", communicationTable.tableName);
  communicationTable.grantReadData(guard.resources.lambda);
  guard.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem"], resources: Object.values(tables).map(tableName => Stack.of(api).formatArn({ service: "dynamodb", resource: "table", resourceName: tableName })) }));
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
      requestMappingTemplate: `#if($util.authType() == "IAM Authorization")\n#if(!$util.isNull($ctx.identity.cognitoIdentityId))\n$util.unauthorized()\n#end\n#return($ctx.prev.result)\n#end\n{"version":"2018-05-29","operation":"Invoke","payload":{"mode":"${mode}","model":"${model}","field":"${field}","operation":"${operation}","identity":$util.toJson($ctx.identity),"arguments":$util.toJson($ctx.arguments),"previous":$util.toJson($ctx.prev.result)}}`,
      responseMappingTemplate: "#if($ctx.error)\n$util.error($ctx.error.message, $ctx.error.type)\n#end\n$util.toJson($ctx.result)",
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
      } else if (scoped) extend(resolver, [], [makeGuard("read", model)]);
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
