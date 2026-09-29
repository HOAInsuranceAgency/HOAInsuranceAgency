/** Historical task schedules are drained by the worker; no reminder migration runs. */
export async function migrateReminderSchedules() { return { retired: true }; }
