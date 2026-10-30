// Reproduce the host's ESM-only loader without implicit process/Buffer globals.
// This imports code and checks an empty private profile; no network or import of controls.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const context = vm.createContext({URL}), modules = new Map();
async function moduleFor(url) {
  if (modules.has(url)) return modules.get(url);
  let loaded;
  if (url.startsWith('node:')) {
    const builtin = await import(url);
    loaded = new vm.SyntheticModule(Object.keys(builtin), function () {
      for (const key of Object.keys(builtin)) this.setExport(key, builtin[key]);
    }, {context, identifier:url});
  } else {
    loaded = new vm.SourceTextModule(fs.readFileSync(new URL(url), 'utf8'), {context, identifier:url,
      initializeImportMeta: meta => {meta.url = url;}});
  }
  modules.set(url, loaded); return loaded;
}
const helper = await moduleFor(pathToFileURL(path.resolve(process.argv[2])).href);
await helper.link((specifier, parent) => moduleFor(specifier.startsWith('node:') ? specifier : new URL(specifier,parent.identifier).href));
await helper.evaluate();
const status = helper.namespace.inspectMarketplaceSetup({stateDirectory:process.argv[3]});
let mutationCode;
try {helper.namespace.applyMarketplaceSetup({localConfigurationAuthorized:true});}
catch (error) {mutationCode=error.code;}
process.stdout.write(JSON.stringify({helper_imported:true,state:status.state,customer_data_read:status.customer_data_read,mutation_runtime_code:mutationCode})+'\n');
