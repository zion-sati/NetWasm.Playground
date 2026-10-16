const handlers = new Map([
  ['text', async (operation, state) => {
    state.files.set(operation.outputPath, await state.host.parse(operation.text));
  }],
  ['tool', executeTool],
  ['validate', executeTool],
  ['inline', async (operation, state) => {
    state.files.set(operation.outputPath, await state.host.inline(state.read(operation.inputPath), operation.selection));
  }],
  ['exports', async (operation, state) => {
    state.files.set(operation.outputPath, await state.host.exports(state.read(operation.inputPath), operation));
  }],
  ['move', async (operation, state) => {
    state.files.set(operation.outputPath, state.read(operation.inputPath));
    state.files.delete(operation.inputPath);
  }],
]);

async function executeTool(_operation, state) {
  const invocation = state.invocations[state.index];
  const inputs = Object.fromEntries(invocation.inputs.map(binding => [binding.physicalName, state.read(binding.logicalPath)]));
  const result = await state.host.tool(invocation.toolId, [...invocation.arguments], inputs,
    invocation.outputs.map(binding => binding.physicalName));
  for (const binding of invocation.outputs) {
    const bytes = result[binding.physicalName];
    if (!(bytes instanceof Uint8Array)) throw Error('Core link tool did not produce its declared output');
    state.files.set(binding.logicalPath, bytes);
  }
}

/** Execute a compiler-preflighted plan. Tool grammar and physical bindings belong to the compiler. */
export async function executeCoreLink(envelope, inputs, host) {
  const { plan, invocations } = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.operations) || !plan.operations.length ||
      !Array.isArray(plan.requiredCapabilities) || !Array.isArray(plan.inputs) ||
      !Array.isArray(plan.outputs) || !plan.outputs.length || !Array.isArray(plan.temporaryPaths) ||
      !invocations || typeof invocations !== 'object') throw Error('Unsupported core link contract');
  const required = new Set(plan.requiredCapabilities);
  if (required.size !== plan.requiredCapabilities.length || [...required].some(kind => !handlers.has(kind)))
    throw Error('Unsupported core link capability');
  const used = new Set();
  const toolIndices = new Set();
  for (const [index, operation] of plan.operations.entries()) {
    if (!operation || !handlers.has(operation.kind) || !required.has(operation.kind))
      throw Error('Unsupported core link operation');
    used.add(operation.kind);
    if (operation.kind !== 'tool' && operation.kind !== 'validate') continue;
    toolIndices.add(String(index));
    const invocation = invocations[index];
    if (!invocation || !['wasm-merge', 'wasm-opt', 'wasm-tools'].includes(invocation.toolId) ||
        !Array.isArray(invocation.arguments) || !invocation.arguments.every(value => typeof value === 'string') ||
        !Array.isArray(invocation.inputs) || !Array.isArray(invocation.outputs))
      throw Error('Invalid compiler tool binding');
    if (invocation.toolId !== (operation.kind === 'validate' ? 'wasm-tools' : operation.toolId))
      throw Error('Compiler tool binding disagrees with its operation');
    const physical = new Set();
    for (const binding of [...invocation.inputs, ...invocation.outputs]) {
      if (!binding || typeof binding.logicalPath !== 'string' || typeof binding.physicalName !== 'string' ||
          !/^[A-Za-z0-9_-]+$/.test(binding.physicalName) || physical.has(binding.physicalName))
        throw Error('Invalid compiler artifact binding');
      physical.add(binding.physicalName);
    }
  }
  if (used.size !== required.size || Object.keys(invocations).some(index => !toolIndices.has(index)))
    throw Error('Core link capability or invocation mismatch');
  const files = new Map();
  for (const path of plan.inputs) {
    if (!(inputs[path] instanceof Uint8Array)) throw Error('Missing core link input');
    files.set(path, inputs[path].slice());
  }
  const state = { files, invocations, host, index: 0, read(path) {
    const bytes = files.get(path);
    if (!(bytes instanceof Uint8Array)) throw Error('Missing core link artifact');
    // Workers may transfer ownership. A subsequent operation must still own this value.
    return bytes.slice();
  } };
  try {
    for (const [index, operation] of plan.operations.entries()) {
      host.checkCancelled();
      state.index = index;
      await handlers.get(operation.kind)(operation, state);
      host.checkCancelled();
    }
    return Object.fromEntries(plan.outputs.map(path => [path, state.read(path)]));
  } finally {
    files.clear();
  }
}
