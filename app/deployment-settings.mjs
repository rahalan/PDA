import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SETTINGS_DIR = path.join(MODULE_ROOT, 'settings');
const SETTINGS_FILES = Object.freeze({
  policy: 'policy.settings.json',
  models: 'models.settings.json',
  tools: 'tools.settings.json',
  agents: 'agents.settings.json',
  credentials: 'credentials.settings.json',
});
const REQUIRED_FIELDS = Object.freeze({
  policy: ['name', 'initialLevelId', 'baselineLevelIds', 'baselineEnvironmentIds', 'levelDefinitions', 'environmentDefinitions', 'initialEnvironmentByBaseLevel', 'allowedModels', 'allowedTools', 'allowedEnvironments', 'scopeTypes', 'scopeDefinitions', 'toolScopeRequirements', 'routeEnvironmentDeclarations', 'classification'],
  models: ['routes', 'preferences', 'routingPools'],
  tools: ['tools'],
  agents: ['defaultAgentId', 'agents'],
  credentials: ['issuer', 'validityHours', 'claims', 'participants'],
});
const REQUIRED_ARRAYS = Object.freeze({
  policy: ['baselineLevelIds', 'baselineEnvironmentIds', 'levelDefinitions', 'environmentDefinitions', 'scopeTypes', 'scopeDefinitions'],
  models: ['routes', 'preferences', 'routingPools'],
  tools: ['tools'],
  agents: ['agents'],
  credentials: ['claims', 'participants'],
});
const SECRET_FIELD_PATTERN = /^(api[-_]?key|password|secret|token|credentialValue)$/i;

function rejectSecretFields(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      throw new Error(`${label}.${key} is not allowed in deployment settings; store secret values through the encrypted Admin flow`);
    }
    rejectSecretFields(child, `${label}.${key}`);
  }
}

function readSettingsFile(settingsDir, domain, fileName) {
  const filePath = path.join(settingsDir, fileName);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load ${domain} settings at ${filePath}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${domain} settings must be an object`);
  }
  if (value.schemaVersion !== 1) throw new Error(`${domain} settings schemaVersion must be 1`);
  for (const field of REQUIRED_FIELDS[domain]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new Error(`${domain} settings is missing ${field}`);
  }
  for (const field of REQUIRED_ARRAYS[domain]) {
    if (!Array.isArray(value[field])) throw new Error(`${domain} settings.${field} must be an array`);
  }
  rejectSecretFields(value, `${domain} settings`);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export function resolveDeploymentSettingsDir(env = process.env) {
  return path.resolve(env.PDA_SETTINGS_DIR || DEFAULT_SETTINGS_DIR);
}

export function loadDeploymentSettings(options = {}) {
  const settingsDir = path.resolve(options.settingsDir || resolveDeploymentSettingsDir(options.env));
  const settings = Object.fromEntries(Object.entries(SETTINGS_FILES).map(([domain, fileName]) => [
    domain,
    readSettingsFile(settingsDir, domain, fileName),
  ]));
  return deepFreeze({ ...settings, settingsDir });
}

export const DEPLOYMENT_SETTINGS = loadDeploymentSettings();

export { DEFAULT_SETTINGS_DIR, SETTINGS_FILES };
