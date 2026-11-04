import { LIST_PARENTS, id, listPartition, object, type RecordData } from "./policy";

/** Only top-level equality predicates establish a partition. OR/NOT and
 * substring predicates must retain the generated administrator list path. */
export function exactListFilterFields(model: string): string[][] {
  if (model === "Document") return [["entityId", "entityType"]];
  const partition = model === "Account" ? "id" : listPartition(model);
  return [[partition], ...(LIST_PARENTS[model] ? [["accountId"]] : [])];
}

export function hasExactListFilter(model: string, filter: RecordData): boolean {
  return exactListFilterFields(model).some(fields => fields.every(field => !!id(object(filter[field]).eq)));
}

/** GraphQL validates field/operator shapes before this template runs. The
 * handler repeats scope validation; this expression only selects the indexed
 * path instead of the native scan, never authorizes a caller. */
export function exactListFilterExpression(model: string): string {
  return exactListFilterFields(model).map(fields => `(${fields.map(field =>
    `!$util.isNullOrEmpty($util.defaultIfNull($assignmentFilter.get("${field}"), {}).get("eq"))`,
  ).join(" && ")})`).join(" || ");
}

/** Broad admin lists keep their native resolver; exact scopes use indexes.
 * View selection still requires verified Cognito membership and one header. */
export function administratorListBypassTemplate(model: string): string {
  return '#set($assignmentFilter = $util.defaultIfNull($ctx.args.filter, {}))\n'
    + `#set($assignmentExact = ${exactListFilterExpression(model)})\n`
    + '#set($assignmentGroups = $util.defaultIfNull($ctx.identity.groups, $util.defaultIfNull($ctx.identity.claims.get("cognito:groups"), [])))\n'
    + '#set($assignmentRole = "")\n#set($assignmentRoleCount = 0)\n#foreach($header in $ctx.request.headers.entrySet())\n#if($header.key.toLowerCase() == "x-crm-role")\n#set($assignmentRole = $header.value)\n#set($assignmentRoleCount = $assignmentRoleCount + 1)\n#end\n#end\n'
    + '#if(!$assignmentExact && (($assignmentRoleCount == 0 && ($assignmentGroups.contains("OWNER") || $assignmentGroups.contains("ADMIN"))) || ($assignmentRoleCount == 1 && (($assignmentRole == "OWNER" && $assignmentGroups.contains("OWNER")) || ($assignmentRole == "ADMIN" && $assignmentGroups.contains("ADMIN"))))))\n#return($ctx.prev.result)\n#end\n';
}
