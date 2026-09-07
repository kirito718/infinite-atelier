// Compatibility export for the existing Zustand adapters. Legacy browser data
// is read only by legacy-migration.ts, never as a fallback for authenticated data.
export { serverStorage as localForageStorage } from "@/services/server-storage";
