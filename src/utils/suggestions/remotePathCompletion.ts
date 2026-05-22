import { posix as posixPath } from 'node:path'

import type { SuggestionItem } from 'src/components/PromptInput/PromptInputFooterSuggestions.js'
import { FileIndex } from 'src/native-ts/file-index/index.js'
import type { RemoteWorkspaceSession } from 'src/ssh/createSSHSession.js'
import { logError } from 'src/utils/log.js'

export type RemotePathCompletionOptions = {
	maxResults?: number
	includeFiles?: boolean
	includeHidden?: boolean
}

type ParsedRemotePath = {
	directory: string
	dirPortion: string
	prefix: string
}

function parseRemotePartialPath(partialPath: string): ParsedRemotePath {
	if (!partialPath) {
		return {
			directory: '.',
			dirPortion: '',
			prefix: '',
		}
	}

	if (partialPath.endsWith('/')) {
		return {
			directory: partialPath,
			dirPortion: partialPath,
			prefix: '',
		}
	}

	const lastSlash = partialPath.lastIndexOf('/')
	if (lastSlash === -1) {
		return {
			directory: '.',
			dirPortion: '',
			prefix: partialPath,
		}
	}

	const dirPortion = partialPath.slice(0, lastSlash + 1)
	return {
		directory: dirPortion,
		dirPortion,
		prefix: partialPath.slice(lastSlash + 1),
	}
}

function findMatchingRemoteEntries(
	entries: string[],
	prefix: string,
	maxResults: number,
): string[] {
	if (!prefix) {
		return entries.slice(0, maxResults)
	}

	const remoteIndex = new FileIndex()
	remoteIndex.loadFromFileList(entries)
	return remoteIndex.search(prefix, maxResults).map((result) => result.path)
}

export async function getRemotePathCompletions(
	session: RemoteWorkspaceSession,
	partialPath: string,
	options: RemotePathCompletionOptions = {},
): Promise<SuggestionItem[]> {
	const { maxResults = 10, includeFiles = true, includeHidden = false } = options

	const { directory, dirPortion, prefix } = parseRemotePartialPath(partialPath)

	try {
		const listing = await session.listDirectory(directory || '.', Math.max(maxResults * 4, 40))
		const visibleEntries = listing.entries.filter(
			(entry) => includeHidden || !entry.startsWith('.'),
		)
		const candidates = findMatchingRemoteEntries(visibleEntries, prefix, maxResults)

		const suggestions = await Promise.all(
			candidates.map(async (entry): Promise<SuggestionItem | null> => {
				const fullPath = dirPortion ? posixPath.join(dirPortion, entry) : entry
				const stat = await session.statPath(fullPath)

				if (!stat.exists) {
					return null
				}

				if (stat.kind !== 'directory' && stat.kind !== 'file') {
					return null
				}

				if (!includeFiles && stat.kind === 'file') {
					return null
				}

				return {
					id: fullPath,
					displayText: stat.kind === 'directory' ? `${fullPath}/` : fullPath,
					metadata: { type: stat.kind },
				} satisfies SuggestionItem
			}),
		)

		return suggestions.filter((suggestion): suggestion is SuggestionItem => suggestion !== null)
	} catch (error) {
		logError(error as Error)
		return []
	}
}
