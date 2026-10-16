import WebSocket from "ws";

// The nodes use the runtime's global WebSocket (n8n runs on Node.js 24). CI
// also tests on Node.js 20, which has none, so give it the `ws` one the CLI uses.
const g = globalThis as { WebSocket?: unknown };
g.WebSocket ??= WebSocket;
