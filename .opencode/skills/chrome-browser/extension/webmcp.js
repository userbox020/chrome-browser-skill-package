import { execute } from './page.js';

export async function listWebMcpTools(tabId) {
  return execute(tabId, async () => {
    try {
      const context = document.modelContext || navigator.modelContext;
      if (!context) return { error: 'WebMCP is not available in this tab. Enable Chrome WebMCP testing support and reload the page.' };
      const tools = await context.getTools();
      return tools.map(tool => normalizeTool(tool));
    } catch (error) {
      return { error: error?.message || String(error) };
    }

    function normalizeTool(tool) {
      const schema = value => {
        if (typeof value !== 'string') return value ?? null;
        try { return JSON.parse(value); } catch { return value; }
      };
      return {
        name: tool.name,
        description: tool.description || '',
        origin: tool.origin || location.origin,
        annotations: tool.annotations || {},
        inputSchema: schema(tool.inputSchema),
        outputSchema: schema(tool.outputSchema),
      };
    }
  });
}

export async function getWebMcpSchema(tabId, toolName) {
  return execute(tabId, async name => {
    try {
      const context = document.modelContext || navigator.modelContext;
      if (!context) return { error: 'WebMCP is not available in this tab.' };
      const tools = await context.getTools();
      const tool = tools.find(item => item.name === name);
      if (!tool) return { error: `No WebMCP tool named: ${name}` };
      const schema = value => {
        if (typeof value !== 'string') return value ?? null;
        try { return JSON.parse(value); } catch { return value; }
      };
      return {
        name: tool.name,
        description: tool.description || '',
        origin: tool.origin || location.origin,
        annotations: tool.annotations || {},
        inputSchema: schema(tool.inputSchema),
        outputSchema: schema(tool.outputSchema),
      };
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }, [toolName]);
}

export async function callWebMcpTool(tabId, toolName, input, confirmed, approvedContext) {
  const inputJson = serializeWebMcpInput(input);
  return execute(tabId, async (name, serializedInput, approved, expectedContext) => {
    // This callback is serialized into Chrome; imported module closures are unavailable.
    const canonical = value => {
      if (Array.isArray(value)) return value.map(canonical);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
    };
    const sameContext = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    try {
      const context = document.modelContext || navigator.modelContext;
      if (!context) return { error: 'WebMCP is not available in this tab.' };
      const tools = await context.getTools();
      const tool = tools.find(item => item.name === name);
      if (!tool) return { error: `No WebMCP tool named: ${name}` };
      const schema = value => {
        if (typeof value !== 'string') return value ?? null;
        try { return JSON.parse(value); } catch { return value; }
      };
      const approvalContext = {
        kind: 'webmcp',
        name: tool.name,
        description: tool.description || '',
        origin: tool.origin || location.origin,
        annotations: tool.annotations || {},
        inputSchema: schema(tool.inputSchema),
      };
      if (approved && !sameContext(expectedContext, approvalContext)) {
        return { confirmationRequired: true, summary: `WebMCP tool metadata changed and requires new approval: ${name}`, approvalContext };
      }
      if (!approved) {
        return { confirmationRequired: true, summary: `Invoke WebMCP tool: ${name}`, approvalContext };
      }
      const result = await context.executeTool(tool, serializedInput);
      if (result === undefined) return { executed: true, result: null };
      let normalized;
      try { normalized = JSON.parse(JSON.stringify(result)); }
      catch { normalized = String(result); }
      return { executed: true, result: normalized };
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }, [toolName, inputJson, Boolean(confirmed), approvedContext || null]);
}

export function serializeWebMcpInput(input) {
  return JSON.stringify(input ?? {});
}

export async function listWebMcpForms(tabId) {
  return execute(tabId, () => [...document.querySelectorAll('form[toolname]')].map((form, index) => ({
    index,
    name: form.getAttribute('toolname') || '',
    description: form.getAttribute('tooldescription') || '',
    action: form.getAttribute('action') || form.action || '',
    method: (form.getAttribute('method') || form.method || 'get').toUpperCase(),
    autoSubmit: form.hasAttribute('toolautosubmit'),
    fieldCount: [...form.elements].filter(element => element.name && !['BUTTON', 'FIELDSET', 'OUTPUT'].includes(element.tagName)).length,
  })));
}

export async function getWebMcpForm(tabId, toolName) {
  return execute(tabId, name => {
    const form = [...document.querySelectorAll('form[toolname]')].find(element => element.getAttribute('toolname') === name);
    if (!form) return { error: `No declarative WebMCP form named: ${name}` };
    const fields = [...form.elements]
      .filter(element => element.name && !['BUTTON', 'FIELDSET', 'OUTPUT'].includes(element.tagName))
      .map(element => ({
        name: element.name,
        tag: element.tagName.toLowerCase(),
        type: element.type || element.tagName.toLowerCase(),
        required: Boolean(element.required),
        label: element.labels?.[0]?.textContent?.trim() || element.getAttribute('aria-label') || '',
        description: element.getAttribute('toolparamdescription') || element.getAttribute('aria-description') || '',
        placeholder: element.getAttribute('placeholder') || '',
        options: element.tagName === 'SELECT'
          ? [...element.options].map(option => ({ value: option.value, title: option.textContent.trim() }))
          : undefined,
      }));
    return {
      name,
      description: form.getAttribute('tooldescription') || '',
      action: form.getAttribute('action') || form.action || '',
      method: (form.getAttribute('method') || form.method || 'get').toUpperCase(),
      autoSubmit: form.hasAttribute('toolautosubmit'),
      fields,
    };
  }, [toolName]);
}
