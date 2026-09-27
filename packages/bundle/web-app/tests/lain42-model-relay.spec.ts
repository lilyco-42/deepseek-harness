import { describe, expect, it } from 'vitest'
import {
  createLain42ModelRelayHeadersResolver,
  LAIN42_AGENT_MODEL_PROVIDER,
  signLain42AgentModelRelayRequest,
} from '../src/lain42-model-relay.ts'

describe('Lain42 model relay header resolver', () => {
  it('signs the server-owned session and selected model without sending the secret', async () => {
    const secret = '0123456789abcdef0123456789abcdef'
    const sessionId = 'a'.repeat(64)
    const headers = await createLain42ModelRelayHeadersResolver(secret).resolve({
      provider: LAIN42_AGENT_MODEL_PROVIDER,
      model: 'deepseek-chat',
      sessionId,
    })

    expect(headers).toMatchObject({
      'x-lain42-agent-session': sessionId,
      'x-lain42-agent-model': 'deepseek-chat',
    })
    expect(headers?.['x-lain42-timestamp']).toMatch(/^\d{10}$/u)
    expect(headers?.['x-lain42-nonce']).toMatch(/^[0-9a-f]{32}$/u)
    expect(headers?.['x-lain42-signature']).toMatch(/^[0-9a-f]{64}$/u)
    expect(headers).not.toHaveProperty('authorization')
    expect(JSON.stringify(headers)).not.toContain(secret)
    expect(headers?.['x-lain42-signature']).toBe(signLain42AgentModelRelayRequest(
      secret,
      headers?.['x-lain42-timestamp'] ?? '',
      headers?.['x-lain42-nonce'] ?? '',
      sessionId,
      'deepseek-chat',
    ))
  })

  it('does not alter unrelated model routes and fails closed for incomplete Lain42 requests', () => {
    const resolver = createLain42ModelRelayHeadersResolver(undefined)
    expect(resolver.resolve({ provider: 'deepseek', model: 'deepseek-chat', sessionId: 'a'.repeat(64) })).toBeUndefined()
    expect(() => resolver.resolve({ provider: LAIN42_AGENT_MODEL_PROVIDER, model: 'deepseek-chat' })).toThrow(/32 UTF-8 bytes/u)

    const configured = createLain42ModelRelayHeadersResolver('0123456789abcdef0123456789abcdef')
    expect(() => configured.resolve({ provider: LAIN42_AGENT_MODEL_PROVIDER, model: 'deepseek-chat' })).toThrow(/server-owned Agent session/u)
    expect(() => configured.resolve({ provider: LAIN42_AGENT_MODEL_PROVIDER, model: 'bad model', sessionId: 'a'.repeat(64) })).toThrow(/server-owned Agent session/u)
  })
})
