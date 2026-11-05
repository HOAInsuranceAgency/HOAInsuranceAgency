import { initializeMonitoring } from "./lib/monitoring";

// This is the first bootstrap import so startup failures are captured too.
initializeMonitoring(import.meta.env);
