import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planIsmaMigration, applyIsmaMigration } from '../mcp/isma-migration.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isma-invented-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('fresh installation and same-person migration preserve settings without transferring cases or approvals', t => {
  const root = fixture(t), source = path.join(root, 'csm-copilot-candidate-live');
  assert.equal(planIsmaMigration({ codexDirectory: root }).state, 'new_installation');
  fs.mkdirSync(source, { mode: 0o700 });
  for (const name of ['credential-state.json', 'gmail-signature-profile.json', 'presenter-profile.json']) fs.writeFileSync(path.join(source, name), JSON.stringify({ invented: name }), { mode: 0o600 });
  fs.writeFileSync(path.join(source, 'case.json'), '{"approvals":["invented"]}');
  assert.throws(() => applyIsmaMigration({ codexDirectory: root }), /Authorize/);
  const result = applyIsmaMigration({ codexDirectory: root, migrationAuthorized: true });
  assert.equal(result.state, 'settings_preserved'); assert.equal(result.source_access_verified, false);
  assert.equal(result.cases_or_approvals_migrated, false); assert.equal(result.legacy_plugins_removed, false);
  assert.equal(JSON.stringify(result).includes('"invented"'), false);
  for (const name of result.settings_to_preserve) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'isma-live', name)), fs.readFileSync(path.join(source, name)));
    assert.equal(fs.statSync(path.join(root, 'isma-live', name)).mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(path.join(root, 'isma-live/case.json')), false);
  assert.equal(applyIsmaMigration({ codexDirectory: root, migrationAuthorized: true }).state, 'settings_preserved');
});
test('conflicting existing ISMA settings and symbolic links fail before replacement', t => {
  const root = fixture(t), source = path.join(root, 'csm-copilot-candidate-live'), target = path.join(root, 'isma-live');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'presenter-profile.json'), 'invented-old');
  fs.writeFileSync(path.join(target, 'presenter-profile.json'), 'invented-current');
  assert.throws(() => applyIsmaMigration({ codexDirectory: root, migrationAuthorized: true }), /different settings/);
  assert.equal(fs.readFileSync(path.join(target, 'presenter-profile.json'), 'utf8'), 'invented-current');
  fs.unlinkSync(path.join(target, 'presenter-profile.json')); fs.symlinkSync(path.join(source, 'presenter-profile.json'), path.join(target, 'presenter-profile.json'));
  assert.throws(() => planIsmaMigration({ codexDirectory: root }), /regular settings/);
  assert.throws(() => planIsmaMigration({ codexDirectory: root, sourceNamespace: '../other' }));
});
