import { Stack } from "aws-cdk-lib";
import { CfnUserPoolIdentityProvider } from "aws-cdk-lib/aws-cognito";
import { googleRedirectUrls, googleSignInEnabled } from "../amplify/auth/config";
import type { backend as Backend } from "../amplify/backend";

/** Check the deployed OAuth boundary as well as the handler's unit tests. */
export function checkGoogleSignIn(backend: typeof Backend) {
  const { cfnUserPool: pool, cfnUserPoolClient: client } = backend.auth.resources.cfnResources;
  const stack = Stack.of(pool);
  const json = (value: unknown) => JSON.stringify(stack.resolve(value));
  const signup = stack.resolve(pool.adminCreateUserConfig) as { allowAdminCreateUserOnly?: boolean };
  if (signup?.allowAdminCreateUserOnly !== true) throw new Error("CRM signup must remain admin-only");
  if (process.env.AWS_BRANCH === "staging") {
    const resources = stack.resolve(pool._toCloudFormation()).Resources as Record<string, {
      Properties: { Policies?: { SignInPolicy?: { AllowedFirstAuthFactors?: string[] } } };
    }>;
    const factors = Object.values(resources)[0].Properties.Policies?.SignInPolicy?.AllowedFirstAuthFactors;
    if (JSON.stringify(factors) !== JSON.stringify(["PASSWORD", "EMAIL_OTP"])) {
      throw new Error("Staging must retain its existing passwordless invitation factor");
    }
  }
  const triggers = stack.resolve(pool.lambdaConfig) as { preSignUp?: unknown };
  if (json(triggers?.preSignUp) !== json(backend.googleSignIn.resources.lambda.functionArn)) {
    throw new Error("Invite-only account linking must remain installed, including when Google is disabled");
  }
  if (json(client.explicitAuthFlows) !== json(["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])) {
    throw new Error("Magic links must retain custom auth without enabling password API flows");
  }
  const schema = stack.resolve(pool.schema) as { name?: string; mutable?: boolean }[];
  if (!schema.some(attribute => attribute.name === "googleHostedDomain" && attribute.mutable === true)) {
    throw new Error("Google's optional hosted-domain attribute must stay mutable and survive disabling Google");
  }

  const providers = backend.stack.node.root.node.findAll().filter(
    (node): node is CfnUserPoolIdentityProvider => node instanceof CfnUserPoolIdentityProvider && node.providerType === "Google",
  );
  if (!googleSignInEnabled) {
    // CDK retains OAuth defaults even without an external provider. Check the
    // actual provider resources and client association rather than those defaults.
    if (providers.length ||
        (stack.resolve(client.supportedIdentityProviders) as string[] | undefined)?.includes("Google")) {
      throw new Error("Google OAuth infrastructure must remain disabled until explicitly configured");
    }
    return;
  }
  if (providers.length !== 1) throw new Error("Google sign-in requires exactly one Google provider");
  const mapping = stack.resolve(providers[0].attributeMapping) as Record<string, string>;
  if (mapping.email !== "email" || mapping.email_verified !== "email_verified" ||
      mapping["custom:googleHostedDomain"] !== "hd") {
    throw new Error("Google linking requires provider-mapped email verification and Workspace domain claims");
  }
  if (json(client.allowedOAuthFlows) !== json(["code"]) || client.generateSecret === true) {
    throw new Error("The CRM browser client must use authorization code flow without a client secret");
  }
  if (json(client.supportedIdentityProviders) !== json(["Google"])) {
    throw new Error("Managed login must offer Google without opening Cognito's password login");
  }
  if (json(client.callbackUrLs) !== json(googleRedirectUrls) || json(client.logoutUrLs) !== json(googleRedirectUrls)) {
    throw new Error("Google sign-in and sign-out must return only to the current CRM environment");
  }
}
