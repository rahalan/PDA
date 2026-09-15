import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS_DIR, SETTINGS_FILES } from '../app/deployment-settings.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixtureSettings() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pda-settings-'));
  for (const fileName of Object.values(SETTINGS_FILES)) {
    fs.copyFileSync(path.join(DEFAULT_SETTINGS_DIR, fileName), path.join(root, fileName));
  }
  return root;
}

function updateJson(root, fileName, update) {
  const filePath = path.join(root, fileName);
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  update(value);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runWithFixture(root, stateDir, script) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PDA_SETTINGS_DIR: root, PDA_TEST_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
  return JSON.parse(output.trim());
}

test('PDA_SETTINGS_DIR configures policy, models, tools, agents, and credential issuance', () => {
  const root = fixtureSettings();
  const stateDir = path.join(root, 'state');
  try {
    updateJson(root, SETTINGS_FILES.policy, value => { value.name = 'Fixture governance policy'; });
    updateJson(root, SETTINGS_FILES.models, value => {
      value.routes.find(route => route.id === 'copilot').model = 'fixture-model';
    });
    updateJson(root, SETTINGS_FILES.tools, value => {
      const weather = value.tools.find(tool => tool.id === 'weather');
      weather.name = 'Fixture weather';
      weather.result.condition = 'fixture skies';
    });
    updateJson(root, SETTINGS_FILES.agents, value => {
      value.agents[0].name = 'Fixture Cairn';
      value.agents[0].runtime.ledgerRecordsPerTurn = 81;
    });
    updateJson(root, SETTINGS_FILES.credentials, value => {
      value.issuer = 'Fixture Credential Authority';
      value.participants.find(participant => participant.id === 'cg-agent-01').label = 'Fixture Cairn';
      value.participants.find(participant => participant.id === 'weather').label = 'Fixture weather';
    });

    const script = `
      import { DEPLOYMENT_SETTINGS } from './app/deployment-settings.mjs';
      import { syntheticToolResult, TOOLS } from './app/catalog.mjs';
      import { Governance } from './app/governance.mjs';
      import { LEDGER_RECORDS_PER_TURN } from './app/agent.mjs';
      import { Store } from './app/storage.mjs';
      const governance = new Governance(new Store(process.env.PDA_TEST_STATE_DIR));
      const credential = governance.credential('cg-agent-01', governance.active().payload.version);
      console.log(JSON.stringify({
        policy: governance.active().payload.name,
        model: governance.settings().routes.copilot.model,
        tool: TOOLS.find(tool => tool.id === 'weather').name,
        result: syntheticToolResult('weather', { city: 'Osaka' }),
        agent: DEPLOYMENT_SETTINGS.agents.agents[0].name,
        ledgerRecordsPerTurn: LEDGER_RECORDS_PER_TURN,
        issuer: credential.record.payload.issuer,
        participantLabel: credential.record.payload.participantLabel,
      }));
    `;
    assert.deepEqual(runWithFixture(root, stateDir, script), {
      policy: 'Fixture governance policy',
      model: 'fixture-model',
      tool: 'Fixture weather',
      result: { temperatureC: 12, condition: 'fixture skies', city: 'Osaka', fictional: true },
      agent: 'Fixture Cairn',
      ledgerRecordsPerTurn: 81,
      issuer: 'Fixture Credential Authority',
      participantLabel: 'Fixture Cairn',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});