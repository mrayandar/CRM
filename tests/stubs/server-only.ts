// Test-only stub for the `server-only` package. It throws when imported
// from a Client Component bundle, which is meaningless outside Next's
// bundler — these integration tests run the real server modules directly
// in Node, so importing it is a no-op here.
export {}
