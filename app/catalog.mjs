import { DEPLOYMENT_SETTINGS } from './deployment-settings.mjs';

export const SCOPE_TYPES = structuredClone(DEPLOYMENT_SETTINGS.policy.scopeTypes);
export const SCOPE_DEFINITIONS = structuredClone(DEPLOYMENT_SETTINGS.policy.scopeDefinitions);
export const TOOLS = structuredClone(DEPLOYMENT_SETTINGS.tools.tools);

export const TOOL_BY_ID = new Map(TOOLS.map((entry) => [entry.id, entry]));
export const SCOPE_BY_ID = new Map(SCOPE_DEFINITIONS.map((entry) => [entry.id, entry]));
export const GLOBAL_TOOL_IDS = TOOLS.filter((entry) => entry.requiredScope).map((entry) => entry.id);

function resolveConfiguredResult(value, args) {
  if (Array.isArray(value)) return value.map(item => resolveConfiguredResult(item, args));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$argument === 'string') {
    const supplied = args[value.$argument];
    const resolved = supplied === undefined || supplied === null ? value.default : supplied;
    return typeof resolved === 'string' && Number.isInteger(value.maxLength)
      ? resolved.slice(0, value.maxLength)
      : resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveConfiguredResult(child, args)]));
}

export function syntheticToolResult(toolId, args = {}) {
  const definition = TOOL_BY_ID.get(toolId);
  if (!definition) throw new Error(`Unknown synthetic tool: ${toolId}`);
  const result = {
    ...resolveConfiguredResult(definition.result, args),
    fictional: true,
  };
  if (definition.requiredScope || definition.minimumLevel !== 'Public' || definition.sovereignty !== 'Public cloud') {
    result._meta = {
      governance: {
        selfDeclared: true,
        attested: false,
        fictional: true,
        requiredScope: structuredClone(definition.requiredScope ?? {}),
        classification: definition.minimumLevel,
        executionPosture: definition.sovereignty,
      },
    };
  }
  return result;
}