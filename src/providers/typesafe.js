import { classifyStatus, messageFromBody } from './common.js';

export default {
  name: 'typesafe',
  // Full endpoint URL, so a gateway speaking the same format can be used as-is.
  defaultBaseUrl: 'https://api.typesafe.ai/v1/systemone',
  defaultModel: 'jev-latest',
  keyEnv: 'TYPESAFE_API_KEY',

  buildBody({ model, state, questions }) {
    return { model, state, questions };
  },

  headers(apiKey) {
    return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  },

  requestId(headers) {
    return headers.get('x-typesafe-request-id') ?? undefined;
  },

  /** @returns {{type: string, message: string}} */
  classifyError(status, body) {
    return {
      type: classifyStatus(status),
      message: messageFromBody(body) ?? `TypeSafe returned HTTP ${status}`,
    };
  },
};
