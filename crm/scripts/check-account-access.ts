import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { CfnPolicy } from "aws-cdk-lib/aws-iam";
import { CfnFunctionConfiguration, type CfnResolver } from "aws-cdk-lib/aws-appsync";
import { ACCOUNT_MODELS, PUBLIC_OPERATIONS, ADMIN_OPERATIONS, SHARED_MODELS } from "../amplify/functions/crm-access/policy";
import type { backend as Backend } from "../amplify/backend";

export function checkAccountAccess(backend: typeof Backend, outdir: string) {
  const functions = backend.data.resources.graphqlApi.node.findAll().filter((node): node is CfnFunctionConfiguration => node instanceof CfnFunctionConfiguration && node.name.startsWith("access_"));
  if (!functions.length) throw new Error("Assignment guards are missing");
  const ids = new Set(functions.map(fn => fn.attrFunctionId));
  for (const resolver of Object.values(backend.data.resources.cfnResources.cfnResolvers)) {
    const target = Object.entries(backend.data.resources.tables).find(([, table]) => resolver.requestMappingTemplate?.includes(`"tableName", "${table.tableName}"`))?.[0];
    const pipeline = resolver.pipelineConfig as CfnResolver.PipelineConfigProperty;
    const guarded = pipeline?.functions?.some(fn => ids.has(fn));
    if (target && (ACCOUNT_MODELS as readonly string[]).includes(target) && !guarded) throw new Error(`Assignment guard missing: ${resolver.typeName}.${resolver.fieldName}`);
    if (!target && resolver.typeName !== "Subscription" && !PUBLIC_OPERATIONS.includes(resolver.fieldName) && !ADMIN_OPERATIONS.includes(resolver.fieldName) && !["crmAccess", "crmFile"].includes(resolver.fieldName) && !guarded) throw new Error(`Custom guard missing: ${resolver.fieldName}`);
    if (resolver.typeName === "Subscription" && !(SHARED_MODELS as readonly string[]).includes(resolver.fieldName.replace(/^on(Create|Update|Delete)/, ""))) throw new Error(`Private broadcast subscription: ${resolver.fieldName}`);
  }
  for (const fn of functions) {
    if (!fn.requestMappingTemplate?.includes('$util.authType() == "IAM Authorization"') || !fn.responseMappingTemplate?.includes("$util.error")) throw new Error("Guard bypass or error handling changed");
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
