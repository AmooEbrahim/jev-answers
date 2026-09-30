import { ErrorType } from '../errors.js';
import { classifyStatus, messageFromBody, TOO_LARGE_PATTERN } from './common.js';

export default {
  name: 'openrouter',
  // Alpha endpoint; it may move. https://openrouter.ai/api/v1/systemone is a TypeSafe-compatible alternative.
  defaultBaseUrl: 'https://openrouter.ai/api/alpha/decisions',
  defaultModel: '~typesafe/jev-latest',
  keyEnv: 'OPENROUTER_API_KEY',

  buildBody({ model, state, questions }) {
    return { model, state, questions };
  },

  headers(apiKey) {
    return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  },

  requestId(headers, body) {
    return typeof body?.id === 'string' ? body.id : (headers.get('x-request-id') ?? undefined);
  },

  classifyError(status, body) {
    const message = messageFromBody(body) ?? `OpenRouter returned HTTP ${status}`;
    // Oversized state comes back as a generic 400 on this endpoint.
    const tooLarge = status === 400 && TOO_LARGE_PATTERN.test(message);
    return { type: tooLarge ? ErrorType.CONTEXT_TOO_LARGE : classifyStatus(status), message };
  },
};
