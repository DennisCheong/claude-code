import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createOpenAICompatibleMessage } from './openaiCompatible.js'
import { normalizeOpenAICompatibleReasoning } from './openaiCompatibleReasoning.js'

describe('normalizeOpenAICompatibleReasoning', () => {
  it('treats id-only and signature-only payloads as lifecycle updates, not visible text', () => {
    const normalized = normalizeOpenAICompatibleReasoning({
      id: 'rs_1',
      signature: 'sig_1',
    })

    assert.equal(normalized.text, undefined)
    assert.equal(normalized.signature, 'sig_1')
  })

  it('ignores null and empty strings until real reasoning text appears', () => {
    const normalized = normalizeOpenAICompatibleReasoning(
      null,
      '',
      {
        reasoning_content: {
          text: '',
        },
      },
      {
        thinking: {
          text: 'visible reasoning',
        },
      },
    )

    assert.equal(normalized.text, 'visible reasoning')
    assert.equal(normalized.signature, undefined)
  })

  it('preserves signature when reasoning text is nested inside object payloads', () => {
    const normalized = normalizeOpenAICompatibleReasoning({
      reasoning_content: {
        id: 'rs_2',
        signature: 'sig_2',
        text: 'final reasoning text',
      },
    })

    assert.equal(normalized.text, 'final reasoning text')
    assert.equal(normalized.signature, 'sig_2')
  })
})

describe('createOpenAICompatibleMessage', () => {
  it('flattens multiple text-only user parts into a single string message', async () => {
    let requestBody: Record<string, unknown> | undefined

    await createOpenAICompatibleMessage(
      {
        model: 'qwen3.6-plus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '<command-message>init</command-message>\n' },
              { type: 'text', text: '<command-name>/init</command-name>\n' },
              { type: 'text', text: 'Set up a minimal CLAUDE.md' },
            ],
          },
        ],
        max_tokens: 16,
      },
      {
        apiKey: 'test-key',
        fetchOverride: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<
            string,
            unknown
          >

          return new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'qwen3.6-plus',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        },
      },
    )

    assert.ok(requestBody)
    assert.deepEqual(requestBody.messages, [
      {
        role: 'user',
        content:
          '<command-message>init</command-message>\n<command-name>/init</command-name>\nSet up a minimal CLAUDE.md',
      },
    ])
  })
})