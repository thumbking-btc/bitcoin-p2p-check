// Use the same secured static/API handler as production without exporting the
// Durable Object class from this storage-disabled version-preview entry.
// Production and staging keep their original entry and Durable Object export.
export { default } from "./index";
