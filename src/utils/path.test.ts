import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isPathWithin } from './path.js'

describe('isPathWithin', () => {
	it('accepts only paths inside the base directory', () => {
		assert.equal(isPathWithin('/workspace/project', '/workspace/project'), true)
		assert.equal(isPathWithin('/workspace/project', '/workspace/project/src/file.ts'), true)
		assert.equal(isPathWithin('/workspace/project', '/workspace/project/..outside/file.ts'), true)
		assert.equal(isPathWithin('/workspace/project', '/workspace/project/../outside/file.ts'), false)
		assert.equal(isPathWithin('/workspace/project', '/workspace/project-sibling/file.ts'), false)
	})
})
