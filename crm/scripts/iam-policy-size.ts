/** Conservative expansion for the CRM role's generated resource references.
 * Counting CloudFormation JSON measures template syntax, not the IAM document.
 * A generated table name is at most 255 chars; full table/bucket ARNs fit in
 * 512. These bounds also cover the role's generated S3/communication grants. */
export function crmPolicySize(document: unknown): number {
  const ref = (name: string) => "x".repeat(({ "AWS::Partition": 12, "AWS::Region": 32, "AWS::AccountId": 12 } as Record<string, number>)[name] ?? 256);
  function expand(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(expand);
    const object = value as Record<string, unknown>;
    if (typeof object.Ref === "string") return ref(object.Ref);
    if (object["Fn::GetAtt"]) {
      const attribute = object["Fn::GetAtt"];
      const name = Array.isArray(attribute) ? attribute[1] : String(attribute).split(".").at(-1);
      return "x".repeat(name === "ApiId" ? 26 : 512);
    }
    if (Array.isArray(object["Fn::Join"])) {
      const [separator, parts] = object["Fn::Join"] as [string, unknown[]];
      return parts.map(expand).join(separator);
    }
    if (Object.keys(object).some(key => key.startsWith("Fn::"))) throw new Error("Unsupported CRM policy expression; extend the size check before deploying");
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, expand(child)]));
  }
  return JSON.stringify(expand(document)).length;
}
