import { readFile } from 'node:fs/promises';
const old = JSON.parse(await readFile(process.argv[2] || 'contract/releases/1.1.0.json'));
const current = JSON.parse(await readFile(process.argv[3] || 'contract/openapi.json'));
export function breakingChanges(previous, next) {
  const changes = [];
  for (const [path, methods] of Object.entries(previous.paths)) for (const [method, operation] of Object.entries(methods)) {
    const replacement = next.paths[path]?.[method];
    if (!replacement) { changes.push(`Removed ${method} ${path}`); continue; }
    const oldParameters = new Map((operation.parameters || []).map(p => [`${p.in}:${p.name}`,p]));
    for (const p of replacement.parameters || []) if (p.required && !oldParameters.get(`${p.in}:${p.name}`)?.required) changes.push(`Required new parameter ${method} ${path}: ${p.name}`);
    const previousBody=operation.requestBody?.content?.['application/json']?.schema;
    const nextBody=replacement.requestBody?.content?.['application/json']?.schema;
    const resolve=(schema,document)=>schema?.$ref ? document.components.schemas[schema.$ref.split('/').at(-1)] : schema;
    const oldBody=resolve(previousBody,previous);const newBody=resolve(nextBody,next);
    if(oldBody && newBody) {
      for(const field of newBody.required || []) if(!(oldBody.required || []).includes(field)) changes.push(`Required new body field ${method} ${path}: ${field}`);
      for(const [field,definition] of Object.entries(oldBody.properties || {})) {
        const other=newBody.properties?.[field];
        if(other?.enum && definition.enum?.some(value=>!other.enum.includes(value))) changes.push(`Narrowed input enum ${method} ${path}: ${field}`);
        if(definition.type && other?.type && definition.type!==other.type) changes.push(`Changed input type ${method} ${path}: ${field}`);
      }
    }
    for (const status of Object.keys(operation.responses || {})) if (!replacement.responses[status]) changes.push(`Removed response ${method} ${path}: ${status}`);
  }
  for (const [name, schema] of Object.entries(previous.components?.schemas || {})) {
    const replacement = next.components?.schemas?.[name];
    if (!replacement) { changes.push(`Removed model ${name}`); continue; }
    for (const field of schema.required || []) if (!(replacement.required || []).includes(field)) changes.push(`Response field is no longer guaranteed: ${name}.${field}`);
    for (const [field, definition] of Object.entries(schema.properties || {})) {
      const other = replacement.properties?.[field];
      if (!other) changes.push(`Removed field ${name}.${field}`);
      else if (definition.type && other.type !== definition.type) changes.push(`Changed type ${name}.${field}`);
      else if (definition.enum && other.enum && definition.enum.some(value => !other.enum.includes(value))) changes.push(`Narrowed enum ${name}.${field}`);
    }
  }
  return changes;
}
const changes = breakingChanges(old,current);
// Newly documented parameters existed before the initial partial contract. Once the
// complete 1.1 baseline is released, new required parameters are breaking changes.
const enforced = old.info.version === '1.0.0' ? changes.filter(change => !change.startsWith('Required new parameter')) : changes;
if (enforced.length && Number(current.info.version.split('.')[0]) <= Number(old.info.version.split('.')[0])) {
  console.error(enforced.join('\n')); process.exitCode = 1;
} else console.info(`Contract compatibility checked (${enforced.length} major-version changes)`);
