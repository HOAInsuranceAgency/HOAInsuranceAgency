/** Retired daily staff email: do not resume READY, LEASED or ACCEPTED editions.
 * Historical editions remain untouched; queued invocations cannot send or reconcile. */
export const handler = async (_event?: unknown) => ({ retired: true, sent: false });
