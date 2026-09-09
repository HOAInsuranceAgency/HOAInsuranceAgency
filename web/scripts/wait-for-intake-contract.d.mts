export const probe: string;
export function contractReady(url: string, key: string, request?: typeof fetch): Promise<boolean>;
export function waitForContract(): Promise<void>;
