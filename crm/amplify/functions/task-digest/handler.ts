/** Retired daily staff email: queued or direct invocations must remain inert. */
export const handler = async (_event?: unknown) => ({ retired: true, sent: false });
