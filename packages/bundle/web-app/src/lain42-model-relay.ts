/** Session-scoped HMAC headers for the New API model/quota relay. */

import { createHmac, randomBytes } from 'node:crypto'
import type { LlmRequestHeadersResolver } from '@deepseek-ai/dsh-llm'

export const LAIN42_AGENT_MODEL_PROVIDER = 'lain42-web'
export const LAIN42_AGENT_MODEL_RELAY_PATH = '/v1/agent/chat/completions'
export const LAIN42_AGENT_MODEL_RELAY_SECRET_ENV = 'LAIN42_AGENT_MODEL_RELAY_SECRET'

const SESSION_ID = /^[A-Za-z0-9]{64}$/u
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/u

/** Resolve per-request signatures without exposing the relay secret to the browser. */
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

/** Canonical v1 HMAC shared with New API's internal model relay. */
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
