import readline from 'node:readline';
import { NAME, TOOL_NAME, VERSION } from '../constants.js';
import { ask } from '../pipeline.js';
import { tool } from './tool.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS =
  "jev-answers has one tool, jev_ask. It sends files (or a diff you wrote to a file) plus typed questions to TypeSafe's Jev decision model and returns typed answers with calibrated probabilities (noul = probability of yes, choice, score) in about a second, for a fraction of a cent. Use it for fast, checkable judgments about specific files or written rules: checking a diff against project rules or requirements before you finish a task, classifying or triaging text, or grading against a rubric. Do not use it for open-ended review or explanations. It never runs git, so write diffs to a file first. Ask narrow questions; many questions per call are fine.";

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const hasId = (msg) => msg.id !== undefined && msg.id !== null;

export function toolResult(result) {
  const out = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  if (result.status === 'error') out.isError = true;
  return out;
}

/**
 * Transport-independent JSON-RPC handler.
 * @param {{send: (msg: object) => void, ask?: typeof ask}} io
 */
export function createHandler({ send, ask: run = ask }) {
  const inflight = new Map(); // request id -> AbortController

  async function callTool(msg) {
    const { name, arguments: args } = msg.params ?? {};
    if (name !== TOOL_NAME) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      return rpcError(msg.id, -32602, '"arguments" must be an object.');
    }
    const controller = new AbortController();
    inflight.set(msg.id, controller);
    const token = msg.params._meta?.progressToken;
    const onProgress = token === undefined ? undefined : (stage, step, total) =>
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step, total, message: stage } });
    try {
      const result = await run(args ?? {}, { signal: controller.signal, onProgress });
      return controller.signal.aborted ? null : rpcResult(msg.id, toolResult(result));
    } finally {
      inflight.delete(msg.id);
    }
  }

  async function handleOne(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(typeof msg?.id === 'string' || typeof msg?.id === 'number' ? msg.id : null, -32600, 'Invalid Request');
    }
    if (!hasId(msg)) {
      if (msg.method === 'notifications/cancelled') inflight.get(msg.params?.requestId)?.abort();
      return null; // other notifications need no reply
    }
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NAME, title: 'Jev Answers', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: [tool] });
      case 'tools/call':
        return callTool(msg);
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  /** Handle one parsed message or a batch; returns the reply to write, or null. */
  async function handle(payload) {
    if (Array.isArray(payload)) {
      if (!payload.length) return rpcError(null, -32600, 'Invalid Request');
      const replies = (await Promise.all(payload.map(handleOne))).filter(Boolean);
      return replies.length ? replies : null;
    }
    return handleOne(payload);
  }

  return { handle };
}

/** Run the stdio server until stdin closes. Only JSON-RPC is written to `output`. */
export function serve({ input = process.stdin, output = process.stdout } = {}) {
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');
  const { handle } = createHandler({ send: write });
  const pending = new Set();

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      write(rpcError(null, -32700, 'Parse error'));
      return;
    }
    const job = handle(payload)
      .then((reply) => reply && write(reply))
      .catch((err) => process.stderr.write(`jev-answers: internal error: ${err?.stack ?? err}\n`))
      .finally(() => pending.delete(job));
    pending.add(job);
  });
  return new Promise((resolve) => lines.on('close', () => Promise.allSettled([...pending]).then(resolve)));
}
