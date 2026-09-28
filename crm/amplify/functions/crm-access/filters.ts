import { object, type RecordData } from "./policy";

/** Recheck the complete filter against the current, consistently read record. */
export function matchesFilter(record: RecordData, filter: RecordData): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (condition == null) return true;
    if (field === "and" || field === "or") {
      if (!Array.isArray(condition)) throw new Error("Invalid list filter");
      return field === "and" ? condition.every(f => matchesFilter(record, object(f))) : condition.some(f => matchesFilter(record, object(f)));
    }
    if (field === "not") return !matchesFilter(record, object(condition));
    return Object.entries(object(condition)).every(([op, expected]) => {
      const value = record[field];
      const contains = () => typeof value === "string" && typeof expected === "string" ? value.includes(expected) : Array.isArray(value) && value.includes(expected);
      const compare = (bound: unknown) => typeof value === "string" && typeof bound === "string" || typeof value === "number" && typeof bound === "number"
        ? value === bound ? 0 : (value as string | number) < (bound as string | number) ? -1 : 1 : undefined;
      switch (op) {
        case "eq": return (value ?? null) === expected;
        case "ne": return (value ?? null) !== expected;
        case "lt": return compare(expected) === -1;
        case "le": return compare(expected) === -1 || compare(expected) === 0;
        case "gt": return compare(expected) === 1;
        case "ge": return compare(expected) === 1 || compare(expected) === 0;
        case "between": return Array.isArray(expected) && [0, 1].includes(compare(expected[0]) ?? -2) && [-1, 0].includes(compare(expected[1]) ?? -2);
        case "contains": return contains();
        case "notContains": return value != null && !contains();
        case "beginsWith": return typeof value === "string" && typeof expected === "string" && value.startsWith(expected);
        case "attributeExists": return (value !== undefined) === expected;
        case "attributeType": return ({ S: typeof value === "string", N: typeof value === "number", BOOL: typeof value === "boolean", NULL: value === null, L: Array.isArray(value), M: value != null && typeof value === "object" && !Array.isArray(value) } as Record<string, boolean>)[String(expected)] === true;
        case "size": return value != null && (typeof value === "string" || Array.isArray(value)) && matchesFilter({ size: typeof value === "string" ? Buffer.byteLength(value) : value.length }, { size: expected });
        default: throw new Error("Unsupported list filter");
      }
    });
  });
}

/** Push down only predicates that cannot exclude a valid result. DynamoDB
 * forbids index key attributes in FilterExpression. AND can retain its other
 * predicates; an incomplete OR/NOT must stay entirely in the final check. */
export function queryFilter(filter: RecordData, partitionKey: string) {
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  let sequence = 0;
  const value = (v: unknown) => { const key = `:f${sequence++}`; values[key] = v; return key; };
  type Expression = { text?: string; complete: boolean };
  const join = (parts: string[], operator: string) => parts.length ? `(${parts.join(` ${operator} `)})` : undefined;
  function fieldExpression(path: string, condition: RecordData): string | undefined {
    return join(Object.entries(condition).map(([op, expected]) => {
      switch (op) {
        case "eq": if (path.startsWith("size(")) return `${path} = ${value(expected)}`; return expected === null ? `(attribute_not_exists(${path}) OR ${path} = ${value(null)})` : `${path} = ${value(expected)}`;
        case "ne": if (path.startsWith("size(")) return `${path} <> ${value(expected)}`; return expected === null ? `(attribute_exists(${path}) AND ${path} <> ${value(null)})` : `(attribute_not_exists(${path}) OR ${path} <> ${value(expected)})`;
        case "lt": case "le": case "gt": case "ge": return `${path} ${{ lt: "<", le: "<=", gt: ">", ge: ">=" }[op]} ${value(expected)}`;
        case "between": {
          if (!Array.isArray(expected) || expected.length !== 2) throw new Error("Invalid list filter");
          return `${path} BETWEEN ${value(expected[0])} AND ${value(expected[1])}`;
        }
        case "contains": return `contains(${path}, ${value(expected)})`;
        case "notContains": return `(attribute_exists(${path}) AND ${path} <> ${value(null)} AND NOT contains(${path}, ${value(expected)}))`;
        case "beginsWith": return `begins_with(${path}, ${value(expected)})`;
        case "attributeExists": return `${expected ? "attribute_exists" : "attribute_not_exists"}(${path})`;
        case "attributeType": return `attribute_type(${path}, ${value(expected)})`;
        case "size": return `((attribute_type(${path}, ${value("S")}) OR attribute_type(${path}, ${value("L")})) AND ${fieldExpression(`size(${path})`, object(expected))})`;
        default: throw new Error("Unsupported list filter");
      }
    }).filter(Boolean), "AND");
  }
  function compile(node: RecordData): Expression {
    const parts: Expression[] = Object.entries(node).filter(([, v]) => v != null).map(([field, condition]) => {
      if (field === partitionKey) return { complete: false };
      if (field === "and" || field === "or") {
        if (!Array.isArray(condition)) throw new Error("Invalid list filter");
        const children = condition.map(child => compile(object(child)));
        const complete = children.every(child => child.complete);
        // Empty filters are true. An empty OR is false and stays in the final
        // predicate rather than inventing a DynamoDB boolean literal.
        if (field === "or" && (!complete || !children.length || children.some(child => !child.text))) return { complete: false };
        return { text: join(children.flatMap(child => child.text ? [child.text] : []), field.toUpperCase()), complete };
      }
      if (field === "not") {
        const child = compile(object(condition));
        return { text: child.complete && child.text ? `NOT (${child.text})` : undefined, complete: child.complete && !!child.text };
      }
      // Nullable GraphQL operator inputs and empty size predicates cannot be
      // translated literally (especially under NOT). Keep them in the final
      // predicate rather than marking an approximate expression complete.
      const operators = object(condition);
      if (Object.entries(operators).some(([op, expected]) => {
        if (expected == null && op !== "eq" && op !== "ne") return true;
        if (op !== "size") return false;
        const size = Object.entries(object(expected));
        return !size.length || size.some(([comparison, bound]) => comparison === "between"
          ? !Array.isArray(bound) || bound.length !== 2 || bound.some(n => typeof n !== "number")
          : !["eq", "ne", "lt", "le", "gt", "ge"].includes(comparison) || typeof bound !== "number");
      })) return { complete: false };
      const name = `#f${sequence++}`; names[name] = field;
      return { text: fieldExpression(name, operators), complete: true };
    });
    return { text: join(parts.flatMap(part => part.text ? [part.text] : []), "AND"), complete: parts.every(part => part.complete) };
  }
  const expression = compile(filter).text;
  if (!expression) return {};
  // Branches discarded under OR/NOT may have allocated unused placeholders.
  const used = new Set(expression.match(/[#:]f\d+/g));
  return { FilterExpression: expression,
    ExpressionAttributeNames: Object.fromEntries(Object.entries(names).filter(([key]) => used.has(key))),
    ExpressionAttributeValues: Object.fromEntries(Object.entries(values).filter(([key]) => used.has(key))) };
}
