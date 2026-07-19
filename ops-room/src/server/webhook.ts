#!/usr/bin/env node

// Thin entrypoint — validates durable configuration before composing the HTTP server.
import { initializeAgentProfileRegistry } from '../services/agent-profile/registry.js';
import { initializeSkillRegistry } from '../services/skill-registry/registry.js';
import { initializeMemorySpaceRegistry } from '../services/memory-space-registry/registry.js';

await initializeAgentProfileRegistry();
await initializeSkillRegistry();
await initializeMemorySpaceRegistry();
await import('./http.js');
