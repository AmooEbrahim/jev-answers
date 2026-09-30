import typesafe from './typesafe.js';
import openrouter from './openrouter.js';
import { JevAnswersError, ErrorType } from '../errors.js';

const providers = { typesafe, openrouter };

export const PROVIDER_NAMES = Object.keys(providers);

export function getProvider(name) {
  const provider = providers[name];
  if (!provider) {
    throw new JevAnswersError(
      ErrorType.CONFIG,
      `Unknown provider "${name}". Use one of: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }
  return provider;
}
