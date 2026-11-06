import type * as Enums from "../../../shared/enums";
import type { QuoteStatus } from "../../../shared/quoteStatus";
import type { Schema } from "../../amplify/data/resource";
import { expect, it } from "vitest";

type SharedEnums = {
  AccountStage: Enums.AccountStage;
  PolicyStatus: Enums.PolicyStatus;
  InvoiceStatus: Enums.InvoiceStatus;
  BillType: Enums.BillType;
  DocumentCategory: Enums.DocumentCategory;
  OcrStatus: Enums.OcrStatus;
  UserRole: Enums.UserRole;
  MarketingTaskResolution: Enums.MarketingTaskResolution;
  MarketingTaskSource: Enums.MarketingTaskSource;
  LicenseHolderType: Enums.LicenseHolderType;
  LicenseClass: Enums.LicenseClass;
  LicenseResidency: Enums.LicenseResidency;
  LicenseStatus: Enums.LicenseStatus;
  ConstructionType: Enums.ConstructionType;
  ReplacementCostType: Enums.ReplacementCostType;
  BuildingDeductibleType: Enums.BuildingDeductibleType;
  CauseOfLoss: Enums.CauseOfLoss;
  AggregateAppliesTo: Enums.AggregateAppliesTo;
  ContactType: Enums.ContactType;
  LegalEntityType: Enums.LegalEntityType;
  GlDeductibleType: Enums.GlDeductibleType;
  GlPremiumBasis: Enums.GlPremiumBasis;
  DoPart: Enums.DoPart;
  DoCoverageType: Enums.DoCoverageType;
  DefenseLimitPosition: Enums.DefenseLimitPosition;
  MarketType: Enums.MarketType;
  PaperType: Enums.PaperType;
  AccountType: Enums.AccountType;
  PropertyType: Enums.PropertyType;
  QuoteStatus: QuoteStatus;
};
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : never : never;
const schemaMatches: { [K in keyof SharedEnums]: Equal<SharedEnums[K], NonNullable<Schema[K]["type"]>> } = {
  AccountStage: true,
  PolicyStatus: true,
  InvoiceStatus: true,
  BillType: true,
  DocumentCategory: true,
  OcrStatus: true,
  UserRole: true,
  MarketingTaskResolution: true,
  MarketingTaskSource: true,
  LicenseHolderType: true,
  LicenseClass: true,
  LicenseResidency: true,
  LicenseStatus: true,
  ConstructionType: true,
  ReplacementCostType: true,
  BuildingDeductibleType: true,
  CauseOfLoss: true,
  AggregateAppliesTo: true,
  ContactType: true,
  LegalEntityType: true,
  GlDeductibleType: true,
  GlPremiumBasis: true,
  DoPart: true,
  DoCoverageType: true,
  DefenseLimitPosition: true,
  MarketType: true,
  PaperType: true,
  AccountType: true,
  PropertyType: true,
  QuoteStatus: true,
};
it("keeps every shared enum exhaustive against the generated schema", () => {
  expect(Object.values(schemaMatches).every(value => value === true)).toBe(true);
});
