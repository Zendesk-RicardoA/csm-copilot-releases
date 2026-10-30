import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseMarketplaceSetupInput} from '../mcp/marketplace-setup.mjs';
import {downloadMarketplaceSetup} from '../mcp/marketplace-setup.mjs';
import {fixture} from './fixtures/marketplace-setup-fixture.mjs';
const helper = fileURLToPath(new URL('../mcp/marketplace-setup.mjs',import.meta.url));

test('setup imports under a host-style ESM loader with no implicit Node globals', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'isma-loader-test-'));
  try {
    const result = spawnSync(process.execPath,['--experimental-vm-modules',
      fileURLToPath(new URL('./fixtures/setup-isolated-loader.mjs',import.meta.url)),helper,path.join(directory,'empty-state')],
    {encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{helper_imported:true,state:'private_setup_required',customer_data_read:false,
      mutation_runtime_code:'MARKETPLACE_SETUP_STANDALONE_REQUIRED'});
    assert.deepEqual(fs.readdirSync(directory),[]);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('empty apply input has one concrete stdin recovery action and no configuration change', () => {
  const result = spawnSync(process.execPath,[helper,'apply'],{encoding:'utf8',input:'',timeout:10000});
  assert.equal(result.status,1); const status=JSON.parse(result.stdout);
  assert.equal(status.code,'MARKETPLACE_SETUP_INPUT_REQUIRED');
  assert.equal(status.configuration_changed,false); assert.equal(status.customer_data_read,false);
  assert.match(status.next_action,/child process.*standard input/i); assert.match(status.next_action,/not repeat/i);
});

test('malformed, oversized and mis-shaped input is rejected without echoing private values', () => {
  const marker='invented-private-value';
  for (const input of ['{"login_hint":"'+marker,'null','[]','"'+marker+'"',
    JSON.stringify({setup_file:'/invented/setup.json',local_configuration_authorized:'yes',login_hint:marker}),
    JSON.stringify({setup_file:'relative.json',local_configuration_authorized:true,login_hint:marker}),
    JSON.stringify({setup_file:'/invented/setup.json',local_configuration_authorized:true,login_hint:marker,extra:marker}),
    marker.repeat(1000)]) {
    assert.throws(()=>parseMarketplaceSetupInput(input),error=>error.code==='MARKETPLACE_SETUP_INVALID'&&!error.message.includes(marker));
  }
  assert.deepEqual(parseMarketplaceSetupInput(JSON.stringify({setup_file:'/invented/setup.json',local_configuration_authorized:true,login_hint:'operator@example.invalid'})),
    {setup_file:'/invented/setup.json',local_configuration_authorized:true,login_hint:'operator@example.invalid'});
});

test('a local-folder registration gives Git-source recovery without network, fallback or setup import', () => fixture(async f => {
  const name=JSON.parse(fs.readFileSync(path.join(f.plugin,'.codex-plugin/plugin.json'))).name;
  await assert.rejects(downloadMarketplaceSetup({...f.options,marketplaceListing:{marketplaces:[{name,root:f.plugin,marketplaceSource:{sourceType:'local',source:f.plugin}}]},
    client:{json:()=>{throw new Error('must not access network');}}}),error=>error.code==='MARKETPLACE_SETUP_SOURCE_REQUIRED'
      &&/private settings/.test(error.message)&&/exact clone URL/.test(error.message)&&/Do not guess/.test(error.message));
  assert.equal(fs.existsSync(f.state),false);
}));
