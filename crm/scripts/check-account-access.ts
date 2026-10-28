import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { CfnManagedPolicy, CfnPolicy, CfnRole } from "aws-cdk-lib/aws-iam";
import { crmPolicySize } from "./iam-policy-size";
import { CfnFunctionConfiguration, type CfnResolver } from "aws-cdk-lib/aws-appsync";
import type { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { ACCOUNT_MODELS, PUBLIC_OPERATIONS, ADMIN_OPERATIONS, OWNER_OPERATIONS, ADMIN_MODEL_OPERATIONS } from "../amplify/functions/crm-access/policy";
import type { backend as Backend } from "../amplify/backend";

export function checkAccountAccess(backend: typeof Backend, outdir: string) {
  const statusTable = backend.data.resources.graphqlApi.node.findChild("TeamUserAccess");
  if ("TeamUserAccess" in backend.data.resources.tables) throw new Error("Team access controls must not be exposed through generated data models");
  const policyDocuments = (fn: typeof backend.teamAdmin) => fn.resources.lambda.node.findAll().flatMap(node =>
    node instanceof CfnPolicy ? [JSON.stringify(Stack.of(node).resolve(node.policyDocument))] : []).join("\n");
  for (const fn of [backend.crmAccess, backend.teamAdmin, backend.communications, backend.communicationWorker, backend.leadIntake, backend.leadReply, backend.assignmentIndexWorker]) {
    const resource = fn.resources.lambda.node.defaultChild as CfnFunction;
    const environment = Stack.of(resource).resolve(resource.environment) as { variables: Record<string, unknown> };
    if (!environment.variables.USER_ACCESS_TABLE || !JSON.stringify(environment.variables.USER_ACCESS_TABLE).includes(statusTable.node.id)) throw new Error(`Missing persistent access table: ${resource.node.path}`);
    if (!policyDocuments(fn).includes("dynamodb:GetItem")) throw new Error(`Missing status read permission: ${resource.node.path}`);
  }
  const managementPolicies = policyDocuments(backend.teamAdmin);
  for (const action of ["cognito-idp:AdminGetUser", "cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser", "cognito-idp:AdminUserGlobalSignOut", "dynamodb:UpdateItem"]) {
    if (!managementPolicies.includes(action)) throw new Error(`Missing team access permission: ${action}`);
  }
  for (const fn of [backend.communications, backend.communicationWorker, backend.leadIntake, backend.leadReply, backend.assignmentIndexWorker]) {
    const policies = policyDocuments(fn);
    for (const action of ["cognito-idp:ListUsers", "cognito-idp:AdminListGroupsForUser", "cognito-idp:ListUsersInGroup", "dynamodb:ConditionCheckItem"]) {
      if (!policies.includes(action)) throw new Error(`Missing Producer assignment permission: ${action}`);
    }
  }
  let inlineSize = 0;
  for (const node of backend.crmAccess.resources.lambda.node.findAll()) {
    if (node instanceof CfnManagedPolicy || node instanceof CfnPolicy) {
      const size = crmPolicySize(Stack.of(node).resolve(node.policyDocument));
      if (node instanceof CfnManagedPolicy && size > 6144) throw new Error(`CRM managed policy exceeds 6,144 characters: ${node.node.path} (${size})`);
      if (node instanceof CfnPolicy) inlineSize += size;
    }
    if (node instanceof CfnRole) {
      const policies = Stack.of(node).resolve(node.policies ?? []) as { policyDocument: unknown }[];
      inlineSize += policies.reduce((total, policy) => total + crmPolicySize(policy.policyDocument), 0);
    }
  }
  if (inlineSize > 10240) throw new Error(`CRM inline policies exceed the aggregate 10,240-character limit (${inlineSize})`);
  const functions = backend.data.resources.graphqlApi.node.findAll().filter((node): node is CfnFunctionConfiguration => node instanceof CfnFunctionConfiguration && node.name.startsWith("access_"));
  if (!functions.length) throw new Error("Assignment guards are missing");
  const ids = new Set(functions.filter(fn => fn.name !== "access_session___").map(fn => fn.attrFunctionId));
  const session = functions.find(fn => fn.name === "access_session___");
  if (!session) throw new Error("Persistent session guard is missing");
  for (const model of ACCOUNT_MODELS) if (!functions.some(fn => fn.name === `access_list_${model}__`)) throw new Error(`Assignment-scoped list missing for ${model}`);
  for (const resolver of Object.values(backend.data.resources.cfnResources.cfnResolvers)) {
    if (resolver.responseMappingTemplate !== undefined && resolver.responseMappingTemplateS3Location !== undefined) throw new Error(`Conflicting inline and S3 response templates: ${resolver.typeName}.${resolver.fieldName}`);
    if (resolver.fieldName === "setTeamUserEnabled" && !resolver.responseMappingTemplate?.includes("$util.toJson($ctx.prev.result)")) throw new Error("Team invalidation must retain the generated pipeline response");
    const target = Object.entries(backend.data.resources.tables).find(([, table]) => resolver.requestMappingTemplate?.includes(`"tableName", "${table.tableName}"`))?.[0];
    const pipeline = resolver.pipelineConfig as CfnResolver.PipelineConfigProperty;
    if (!PUBLIC_OPERATIONS.includes(resolver.fieldName) && pipeline?.functions?.[0] !== session.attrFunctionId) throw new Error(`Session guard must run first: ${resolver.typeName}.${resolver.fieldName}`);
    if (PUBLIC_OPERATIONS.includes(resolver.fieldName) && pipeline?.functions?.includes(session.attrFunctionId)) throw new Error(`Public operation requires a CRM session: ${resolver.fieldName}`);
    if ((pipeline?.functions?.length ?? 0) > 10) throw new Error(`Too many pipeline stages: ${resolver.fieldName}`);
    const guarded = pipeline?.functions?.some(fn => ids.has(fn));
    const admin = functions.find(fn => fn.name === "access_admin___");
    const owner = functions.find(fn => fn.name === "access_owner___");
    if (OWNER_OPERATIONS.includes(resolver.fieldName) && (!owner || !pipeline?.functions?.includes(owner.attrFunctionId))) throw new Error(`Active owner guard missing: ${resolver.fieldName}`);
    const operation = resolver.typeName === "Mutation" ? /^(create|update|delete)/.exec(resolver.fieldName)?.[1] ?? "" : "read";
    if ((ADMIN_OPERATIONS.includes(resolver.fieldName) || target && ADMIN_MODEL_OPERATIONS[target]?.includes(operation)) && (!admin || !pipeline?.functions?.includes(admin.attrFunctionId))) throw new Error(`Active administrator guard missing: ${resolver.fieldName}`);
    if (target && (ACCOUNT_MODELS as readonly string[]).includes(target) && !guarded) throw new Error(`Assignment guard missing: ${resolver.typeName}.${resolver.fieldName}`);
    if (target && (ACCOUNT_MODELS as readonly string[]).includes(target) && resolver.typeName === "Query") {
      const data = Object.values(backend.data.resources.cfnResources.cfnFunctionConfigurations).find(fn => pipeline?.functions?.includes(fn.attrFunctionId) && fn.requestMappingTemplate?.includes('"Scan"'));
      if (data) {
        const indexed = functions.find(fn => fn.name === `access_list_${target}__`);
        if (!indexed || !pipeline.functions?.includes(indexed.attrFunctionId) || !data.requestMappingTemplate?.startsWith('#if(!$util.isNull($ctx.stash.assignmentList))')) throw new Error(`Global scan remains for scoped list: ${resolver.fieldName}`);
        const at = pipeline.functions.indexOf(indexed.attrFunctionId);
        if (at < 1 || pipeline.functions[at + 1] !== data.attrFunctionId) throw new Error(`Scoped list must run between native authorization and data: ${resolver.fieldName}`);
      }
    }
    if (!target && resolver.typeName !== "Subscription" && !PUBLIC_OPERATIONS.includes(resolver.fieldName) && !ADMIN_OPERATIONS.includes(resolver.fieldName) && !["crmAccess", "crmFile"].includes(resolver.fieldName) && !guarded) throw new Error(`Custom guard missing: ${resolver.fieldName}`);
    if (resolver.typeName === "Subscription" && (resolver.fieldName.replace(/^on(Create|Update|Delete)/, "") !== "AgencySettings" || !resolver.responseMappingTemplate?.includes("setSubscriptionInvalidationFilter") || !resolver.responseMappingTemplate?.includes('"value":$ctx.identity.sub'))) throw new Error(`Unrevocable broadcast subscription: ${resolver.fieldName}`);
    if (resolver.fieldName === "setTeamUserEnabled" && ["onCreateAgencySettings", "onUpdateAgencySettings", "onDeleteAgencySettings"].some(field => !resolver.responseMappingTemplate?.includes(`"subscriptionField":"${field}"`))) throw new Error("Team deactivation must invalidate all supported broadcasts");
    if (resolver.fieldName === "setTeamUserEnabled" && (!resolver.responseMappingTemplate?.includes("$ctx.arguments.enabled == false") || !resolver.responseMappingTemplate.includes('"userId":$ctx.prev.result.userId'))) throw new Error("Team invalidation must use the final pipeline identity, including uncertain shutdowns");
  }
  for (const fn of functions) {
    if (!fn.requestMappingTemplate?.includes('$util.authType() == "IAM Authorization"') || !fn.responseMappingTemplate?.includes("$util.error")) throw new Error("Guard bypass or error handling changed");
    if (!fn.requestMappingTemplate.includes('"request":$util.toJson($ctx.request)')) throw new Error("Assignment guards must receive the active-role header");
    if (fn.name.startsWith("access_list_") && !fn.requestMappingTemplate.includes('claims.get("cognito:groups")')) throw new Error("Scoped lists must recognize administrators from Cognito JWT claims");
    if (fn.name.startsWith("access_list_") && (!fn.requestMappingTemplate.includes('"x-crm-role"') || !fn.requestMappingTemplate.includes('$assignmentRole == "ADMIN"') || !fn.requestMappingTemplate.includes('$assignmentRole == "OWNER"'))) throw new Error("Scoped list bypass must require the active administrator role");
  }
  const roles = [backend.auth.resources.authenticatedUserIamRole, backend.auth.resources.unauthenticatedUserIamRole, ...Object.values(backend.auth.resources.groups).map(group => group.role)];
  // Group policies must not retain direct bucket grants that bypass crmFile.
  for (const role of roles) for (const node of role.node.findAll()) {
    if (node instanceof CfnPolicy && /s3:(GetObject|PutObject|DeleteObject|ListBucket|\*)/.test(JSON.stringify(Stack.of(node).resolve(node.policyDocument)))) throw new Error("Cognito role retains direct S3 access");
  }

  // CDK validates stack boundaries, but CloudFormation also rejects dependency
  // cycles *within* nested templates. Guards cross model/function boundaries.
  for (const filename of readdirSync(outdir, { recursive: true }).filter(name => typeof name === "string" && name.endsWith(".template.json")) as string[]) {
    const template = JSON.parse(readFileSync(join(outdir, filename), "utf8"));
    const resources = template.Resources ?? {};
    if (Object.keys(resources).length > 500) throw new Error(`CloudFormation resource limit exceeded in ${filename}`);
    const refs = (value: unknown): string[] => {
      if (!value || typeof value !== "object") return [];
      if (Array.isArray(value)) return value.flatMap(refs);
      const object = value as Record<string, unknown>;
      return [typeof object.Ref === "string" ? object.Ref : "", ...(Array.isArray(object["Fn::GetAtt"]) ? [String(object["Fn::GetAtt"][0])] : []), ...Object.values(object).flatMap(refs)].filter(Boolean);
    };
    const edges = new Map<string, string[]>();
    for (const [name, value] of Object.entries(resources)) {
      const item = value as { DependsOn?: string[] | string; Properties?: unknown };
      edges.set(name, [...refs(item.Properties), ...(Array.isArray(item.DependsOn) ? item.DependsOn : item.DependsOn ? [item.DependsOn] : [])].filter(ref => ref in resources && ref !== name));
    }
    const complete = new Set<string>(), visiting = new Set<string>();
    const visit = (name: string, path: string[]) => {
      if (visiting.has(name)) throw new Error(`CloudFormation dependency cycle in ${filename}: ${[...path, name].join(" -> ")}`);
      if (complete.has(name)) return;
      visiting.add(name);
      for (const next of edges.get(name) ?? []) visit(next, [...path, name]);
      visiting.delete(name); complete.add(name);
    };
    for (const name of edges.keys()) visit(name, []);
  }
}
