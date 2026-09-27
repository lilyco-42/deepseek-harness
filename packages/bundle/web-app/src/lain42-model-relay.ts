/** Session-scoped HMAC headers for the New API model/quota relay. */

import { createHmac, randomBytes } from 'node:crypto'
import type { LlmRequestHeadersResolver } from '@deepseek-ai/dsh-llm'

/** Provider id used by the web Agent's server-owned model relay. */
export const LAIN42_AGENT_MODEL_PROVIDER = 'lain42-web'
/** Internal New API endpoint that receives signed model requests. */
export const LAIN42_AGENT_MODEL_RELAY_PATH = '/v1/agent/chat/completions'
/** Environment variable that stores the shared model-relay HMAC secret. */
export const LAIN42_AGENT_MODEL_RELAY_SECRET_ENV = 'LAIN42_AGENT_MODEL_RELAY_SECRET'

const SESSION_ID = /^[A-Za-z0-9]{64}$/u
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/u

/** Resolve per-request signatures without exposing the relay secret to the browser.
 * @param secret Optional shared secret; defaults to the server environment value.
 * @returns Resolver that signs requests for the Lain42 model provider.
 */
export function createLain42ModelRelayHeadersResolver(
  secret: string | undefined = process.env[LAIN42_AGENT_MODEL_RELAY_SECRET_ENV],
): LlmRequestHeadersResolver {
  return {
    resolve(input) {
      if (input.provider !== LAIN42_AGENT_MODEL_PROVIDER) return undefined
      if (secret === undefined || Buffer.byteLength(secret, 'utf8') < 32) {
        throw new Error(`${LAIN42_AGENT_MODEL_RELAY_SECRET_ENV} must be configured with at least 32 UTF-8 bytes`)
      }
      const sessionId = input.sessionId
      if (sessionId === undefined || !SESSION_ID.test(sessionId) || !MODEL_ID.test(input.model)) {
        throw new Error('Lain42 model relay requires a valid server-owned Agent session and model id')
      }

      const timestamp = String(Math.floor(Date.now() / 1000))
      const nonce = randomBytes(16).toString('hex')
      return {
        'x-lain42-agent-session': sessionId,
        'x-lain42-agent-model': input.model,
        'x-lain42-timestamp': timestamp,
        'x-lain42-nonce': nonce,
        'x-lain42-signature': signLain42AgentModelRelayRequest(secret, timestamp, nonce, sessionId, input.model),
      }
    },
  }
}

/** Canonical v1 HMAC shared with New API's internal model relay.
 * @param secret Shared HMAC secret configured on the Agent and New API servers.
 * @param timestamp Unix timestamp in seconds included in the signed headers.
 * @param nonce Unique 128-bit lowercase hexadecimal request nonce.
 * @param sessionId Server-owned Agent session id bound to the request.
 * @param model Provider model id bound to the request.
 * @returns Lowercase hexadecimal HMAC-SHA256 signature.
 */
export function signLain42AgentModelRelayRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  sessionId: string,
  model: string,
): string {
  const canonical = `v1\n${timestamp}\n${nonce}\nPOST\n${LAIN42_AGENT_MODEL_RELAY_PATH}\n${sessionId}\n${model}`
  return createHmac('sha256', secret).update(canonical).digest('hex')
}
