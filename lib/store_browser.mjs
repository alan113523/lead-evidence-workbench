import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, renameSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import binding from './store_binding.js';

export const bindingSource = () => readFileSync(new URL('./store_binding.js', import.meta.url), 'utf8');
export const browserModule = source => `const storeBinding = (() => { const module = {exports:{}};\n${source}\nreturn module.exports; })();\n`;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function privatePath(input) {
  check(typeof input === 'string' && input.length, 'path_required');
  const base = resolve('data'), path = resolve(input), rel = relative(base, path);
  check(rel && !rel.startsWith('..') && !isAbsolute(rel), 'files_must_be_inside_ignored_data');
  for (let p = path; p !== dirname(base); p = dirname(p))
    check(!existsSync(p) || !lstatSync(p).isSymbolicLink(), 'symlink_not_allowed');
  return path;
}
function save(file, value, replace = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  if (!replace) return writeFileSync(file, text, {encoding:'utf8', flag:'wx', mode:0o600});
  const temp = `${file}.${randomUUID()}.tmp`;
  save(temp, text); renameSync(temp, file);
}
export function prepareProbe({channel, browserId, out}) {
  const route = binding.binding({channel, browser_id:browserId}), directory = privatePath(out);
  check(!existsSync(directory), 'probe_already_exists');
  mkdirSync(directory, {recursive:true});
  const ticket = {browser_binding:route, request_id:randomUUID()};
  const expression = `(async () => {\n${browserModule(bindingSource())}return storeBinding.probe(${JSON.stringify(route)},${JSON.stringify(ticket.request_id)});\n})()`;
  save(join(directory, 'request.json'), ticket);
  save(join(directory, 'identity.browser.js'), expression);
  save(join(directory, 'identity.devtools.js'), `async () => { return ${expression}; }`);
  return {browser_binding:route, script:join(directory, 'identity.browser.js'), devtools_function:join(directory, 'identity.devtools.js'), response:join(directory, 'response.json')};
}
export function acceptProbe({probe, response, map}) {
  const ticket = read(join(privatePath(probe), 'request.json')), value = read(privatePath(response)), target = privatePath(map);
  binding.proof(value, value.store_key, ticket.browser_binding, ticket.request_id);
  const current = existsSync(target) ? binding.routes(read(target)) : {schema_version:'alibaba-store-browser-map-v1', bindings:[]};
  const old = current.bindings.find(row => row.store_key === value.store_key && row.browser_binding.channel === value.browser_binding.channel);
  check(!old || binding.same(old.browser_binding, value.browser_binding), 'store_already_bound_use_new_map');
  const next = binding.routes({...current, bindings:[...current.bindings.filter(row => row !== old), value]});
  mkdirSync(dirname(target), {recursive:true});
  save(target, next, existsSync(target));
  return {store_key:value.store_key, browser_binding:value.browser_binding, mapped_stores:new Set(next.bindings.map(row=>row.store_key)).size,
    mapped_routes:next.bindings.length, map:target};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action,...args] = process.argv.slice(2), options = {};
    check(args.length % 2 === 0, 'argument_value_required');
    for (let i=0;i<args.length;i+=2) { check(args[i].startsWith('--'), 'invalid_argument'); options[args[i]]=args[i+1]; }
    let result;
    if (action === 'probe') result = prepareProbe({channel:options['--channel'], browserId:options['--browser'], out:options['--out']});
    else if (action === 'accept') result = acceptProbe({probe:options['--probe'], response:options['--response'], map:options['--map']});
    else if (action === 'route') result = binding.resolve(read(privatePath(options['--map'])), options['--store'], options['--channel']);
    else throw new Error('use_probe_accept_or_route');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({error:/^[a-z_]+$/.test(error.message) ? error.message : 'local_binding_error'})); process.exitCode=1;
  }
}
