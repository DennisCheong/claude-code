import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RemoteWorkspaceSession, SSHSessionError } from './createSSHSession.js'

describe('RemoteWorkspaceSession.resolveRemotePath', () => {
	it('keeps remote mention paths inside the workspace root', () => {
		const session = new RemoteWorkspaceSession('local', '/workspace/project', true)

		assert.equal(session.resolveRemotePath('src/file.ts'), '/workspace/project/src/file.ts')
		assert.equal(
			session.resolveRemotePath('/workspace/project/src/file.ts'),
			'/workspace/project/src/file.ts',
		)
		assert.equal(
			session.resolveRemotePath('..outside/file.ts'),
			'/workspace/project/..outside/file.ts',
		)

		assert.throws(() => session.resolveRemotePath('../outside/file.ts'), SSHSessionError)
		assert.throws(
			() => session.resolveRemotePath('/workspace/project-sibling/file.ts'),
			SSHSessionError,
		)
	})
})
