import { describe, expect, it } from "vitest";
import { queryFilter } from "../../amplify/functions/crm-access/filters";

describe("DynamoDB query filter pushdown", () => {
  it("retains ordinary search OR predicates and excludes the partition key", () => {
    const result = queryFilter({ entityId: { eq: "a" }, or: [{ name: { contains: "needle" } }, { ocrText: { contains: "needle" } }] }, "entityId");
    expect(result.FilterExpression).toContain(" OR ");
    expect(Object.values(result.ExpressionAttributeNames!)).toEqual(["name", "ocrText"]);
    expect(Object.values(result.ExpressionAttributeValues!)).toEqual(["needle", "needle"]);
  });
  it("does not narrow mixed-key OR/NOT, including a partial AND nested inside OR", () => {
    for (const filter of [
      { or: [{ accountId: { eq: "a" } }, { name: { eq: "B" } }] },
      { or: [{ and: [{ accountId: { eq: "a" } }, { name: { eq: "A" } }] }, { name: { eq: "B" } }] },
      { not: { and: [{ accountId: { eq: "b" } }, { name: { eq: "A" } }] } },
      { not: { or: [] } },
      { or: [{}, { name: { eq: "B" } }] },
    ]) expect(queryFilter(filter, "accountId")).toEqual({});
    const result = queryFilter({ active: { eq: true }, not: { and: [{ accountId: { eq: "b" } }, { name: { eq: "A" } }] } }, "accountId");
    expect(Object.values(result.ExpressionAttributeNames!)).toEqual(["active"]);
    expect(Object.values(result.ExpressionAttributeValues!)).toEqual([true]);
  });
  it("pushes comparisons, ranges, existence, types, sizes and complete negation", () => {
    const result = queryFilter({ not: { name: { beginsWith: "Old" } }, amount: { between: [10, 20], ge: 10 }, deleted: { attributeExists: false }, active: { attributeType: "BOOL" }, tags: { notContains: "Private", size: { ne: 0 } } }, "accountId");
    expect(result.FilterExpression).toContain("NOT (");
    expect(result.FilterExpression).toContain(" BETWEEN ");
    expect(result.FilterExpression).toContain("attribute_type(");
    expect(result.FilterExpression).toMatch(/size\(#f\d+\) <> :f\d+/);
    expect(result.FilterExpression).not.toContain("attribute_not_exists(size(");
    // Every allocated placeholder must appear, otherwise DynamoDB rejects it.
    const used = new Set(result.FilterExpression!.match(/[#:]f\d+/g));
    expect(used).toEqual(new Set([...Object.keys(result.ExpressionAttributeNames!), ...Object.keys(result.ExpressionAttributeValues!)]));
  });
  it("preserves missing/null equality and inequality semantics", () => {
    expect(queryFilter({ name: { eq: null } }, "accountId").FilterExpression).toContain("attribute_not_exists(");
    expect(queryFilter({ name: { ne: null } }, "accountId").FilterExpression).toContain("attribute_exists(");
    expect(queryFilter({ name: { ne: "A" } }, "accountId").FilterExpression).toContain("attribute_not_exists(");
  });
  it("leaves nullable operators and empty size predicates out of negated pushdown", () => {
    for (const name of [{ attributeExists: null }, { beginsWith: null }, { size: {} }, { size: { ne: null } }]) {
      expect(queryFilter({ not: { name } }, "accountId")).toEqual({});
    }
    const result = queryFilter({ not: { name: { size: { ge: 1 } } } }, "accountId");
    expect(result.FilterExpression).toContain("attribute_type(");
    expect(Object.values(result.ExpressionAttributeValues!)).toEqual(["S", "L", 1]);
  });
});
