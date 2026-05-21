import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createOpenAICompatibleMessage,
  createOpenAICompatibleStream,
} from './openaiCompatible.js'
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

describe('createOpenAICompatibleStream', () => {
  it('does not emit visible thinking blocks for null or empty reasoning deltas', async () => {
    const encoder = new TextEncoder()
    const sseBody = [
      {
        id: 'chatcmpl_1',
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              reasoning_content: null,
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl_1',
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            delta: {
              content: null,
              reasoning_content: '',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl_1',
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            delta: {
              content: 'hello world',
              reasoning_content: null,
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl_1',
        model: 'qwen3.6-plus',
        choices: [
          {
            index: 0,
            delta: {
              content: '',
              reasoning_content: null,
            },
            finish_reason: 'stop',
          },
        ],
      },
    ]
      .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
      .concat('data: [DONE]\n\n')
      .join('')

    const result = await createOpenAICompatibleStream(
      {
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Say hello world' }],
        max_tokens: 32,
      },
      {
        apiKey: 'test-key',
        fetchOverride: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(sseBody))
                controller.close()
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            },
          ),
      },
    )

    const events: Array<{ type: string; [key: string]: unknown }> = []
    for await (const event of result.data) {
      events.push(event as { type: string; [key: string]: unknown })
    }

    const thinkingStarts = events.filter(
      event =>
        event.type === 'content_block_start' &&
        (event.content_block as { type?: string } | undefined)?.type === 'thinking',
    )
    assert.equal(thinkingStarts.length, 0)

    const textDeltas = events.filter(
      event =>
        event.type === 'content_block_delta' &&
        (event.delta as { type?: string } | undefined)?.type === 'text_delta',
    )
    assert.deepEqual(
      textDeltas.map(event => (event.delta as { text?: string }).text),
      ['hello world'],
    )
  })
})