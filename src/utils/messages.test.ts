import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  appendStreamingThinking,
  startStreamingThinking,
  stopStreamingThinking,
} from './streamingThinkingState.js'

describe('streamingThinkingState', () => {
  it('updates streaming thinking incrementally from thinking deltas', () => {
    let thinking = startStreamingThinking()

    assert.deepEqual(thinking, {
      thinking: '',
      isStreaming: true,
    })

    thinking = appendStreamingThinking(thinking, 'Here')
    thinking = appendStreamingThinking(thinking, ' we go')

    assert.deepEqual(thinking, {
      thinking: 'Here we go',
      isStreaming: true,
    })

    const beforeStop = Date.now()
    thinking = stopStreamingThinking(thinking, beforeStop)!

    assert.equal(thinking.thinking, 'Here we go')
    assert.equal(thinking.isStreaming, false)
    assert.equal(thinking.streamingEndedAt, beforeStop)
  })
})