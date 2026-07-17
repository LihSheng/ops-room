#!/usr/bin/env node

// Thin entrypoint — validates durable configuration before composing the HTTP server.
import { initializeAgentProfileRegistry } from '../services/agent-profile/registry.js';

await initializeAgentProfileRegistry();
await import('./http.js');
