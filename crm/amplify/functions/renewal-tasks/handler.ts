/** Compatibility handler: renewal task generation is permanently retired. */
export const handler = async () => ({ retired: true, created: 0, completed: 0 });
