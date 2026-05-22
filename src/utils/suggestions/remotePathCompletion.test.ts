import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { RemoteWorkspaceSession } from 'src/ssh/createSSHSession.js'

import { getRemotePathCompletions } from './remotePathCompletion.js'

function createRemoteSessionStub(
	entriesByDirectory: Record<string, string[]>,
	directories: Set<string> = new Set(),
): RemoteWorkspaceSession {
	return {
		listDirectory: async (targetPath: string, maxEntries: number) => {
			const entries = entriesByDirectory[targetPath] ?? []
			return {
				entries: entries.slice(0, maxEntries),
				totalEntries: entries.length,
				truncated: entries.length > maxEntries,
			}
		},
		statPath: async (targetPath: string) => ({
			exists: true,
			kind: directories.has(targetPath) ? 'directory' : 'file',
		}),
	} as RemoteWorkspaceSession
}

describe('getRemotePathCompletions', () => {
	it('shows top-level remote entries for bare $ and hides dotfiles by default', async () => {
		const session = createRemoteSessionStub({
			'.': ['.claude', 'astar.php', 'bypass_check.php', 'sort.php'],
		})

		const suggestions = await getRemotePathCompletions(session, '', {
			maxResults: 10,
		})

		assert.deepEqual(
			suggestions.map((suggestion) => suggestion.displayText),
			['astar.php', 'bypass_check.php', 'sort.php'],
		)
	})

	it('uses fuzzy matching within the current remote directory', async () => {
		const session = createRemoteSessionStub({
			'.': ['astar.php', 'bypass_check.php', 'sort.php'],
		})

		const suggestions = await getRemotePathCompletions(session, 'as', {
			maxResults: 10,
		})

		assert.equal(suggestions[0]?.displayText, 'astar.php')
		assert.ok(suggestions.some((suggestion) => suggestion.displayText === 'bypass_check.php'))
	})

	it('keeps directory prefixes when completing nested remote paths', async () => {
		const session = createRemoteSessionStub(
			{
				'src/': ['file.ts', 'folder'],
			},
			new Set(['src/folder']),
		)

		const suggestions = await getRemotePathCompletions(session, 'src/fi', {
			maxResults: 10,
		})

		assert.deepEqual(
			suggestions.map((suggestion) => suggestion.displayText),
			['src/file.ts'],
		)
	})
})
