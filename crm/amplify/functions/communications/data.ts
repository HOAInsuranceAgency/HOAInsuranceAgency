import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
let client: ReturnType<typeof generateClient<Schema>> | undefined;
export async function dataClient() {
  if (!client) {
    const c = await getAmplifyDataClientConfig(process.env as never);
    Amplify.configure(c.resourceConfig, c.libraryOptions);
    client = generateClient<Schema>();
  }
  return client;
}
