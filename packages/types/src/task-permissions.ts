import { z } from "zod"

/**
 * TaskPermissions defines permission boundaries that a parent task can impose
 * on a subtask created via the `new_task` tool.
 *
 * When nested subtasks are created, permissions are merged using
 * "most-restrictive-wins" semantics: a child can never grant itself
 * more access than its parent.
 */

export const taskPermissionsSchema = z.object({
	/**
	 * Regex patterns for allowed file paths.
	 * When set, file operations (read/write) are restricted to paths matching
	 * at least one of these patterns.
	 */
	filePatterns: z.array(z.string()).optional(),

	/**
	 * Regex patterns for allowed shell commands.
	 * When set, command execution is restricted to commands matching
	 * at least one of these patterns.
	 */
	commandPatterns: z.array(z.string()).optional(),

	/**
	 * Explicit tool allowlist. When set, only these tools may be used
	 * by the subtask (in addition to always-available tools like
	 * attempt_completion and ask_followup_question).
	 */
	allowedTools: z.array(z.string()).optional(),

	/**
	 * Explicit tool blocklist. These tools are denied regardless of
	 * mode configuration.
	 */
	deniedTools: z.array(z.string()).optional(),
})

export type TaskPermissions = z.infer<typeof taskPermissionsSchema>

/**
 * Merge two TaskPermissions using most-restrictive-wins semantics.
 *
 * - filePatterns / commandPatterns: if both define patterns, keep only patterns
 *   present in both (intersection). If only one side defines patterns, use that.
 * - allowedTools: intersection of both lists (if both defined).
 * - deniedTools: union of both lists (most restrictive).
 *
 * @returns merged permissions, or undefined if both inputs are undefined.
 */
export function mergeTaskPermissions(
	parent: TaskPermissions | undefined,
	child: TaskPermissions | undefined,
): TaskPermissions | undefined {
	if (!parent && !child) {
		return undefined
	}
	if (!parent) {
		return child
	}
	if (!child) {
		return parent
	}

	return {
		filePatterns: intersectOptionalArrays(parent.filePatterns, child.filePatterns),
		commandPatterns: intersectOptionalArrays(parent.commandPatterns, child.commandPatterns),
		allowedTools: intersectOptionalArrays(parent.allowedTools, child.allowedTools),
		deniedTools: unionOptionalArrays(parent.deniedTools, child.deniedTools),
	}
}

/**
 * Check if a value matches at least one pattern in a list of regex patterns.
 */
export function matchesAnyPattern(value: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		try {
			return new RegExp(pattern).test(value)
		} catch {
			// Invalid regex -- treat as non-match
			return false
		}
	})
}

/**
 * Intersect two optional arrays. If both are defined, return elements present
 * in both. If only one is defined, return that one. If neither, return undefined.
 */
function intersectOptionalArrays(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	if (!a && !b) {
		return undefined
	}
	if (!a) {
		return b
	}
	if (!b) {
		return a
	}

	const setB = new Set(b)
	const result = a.filter((item) => setB.has(item))
	return result.length > 0 ? result : []
}

/**
 * Union two optional arrays, deduplicating entries.
 */
function unionOptionalArrays(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	if (!a && !b) {
		return undefined
	}
	if (!a) {
		return b
	}
	if (!b) {
		return a
	}

	return [...new Set([...a, ...b])]
}
