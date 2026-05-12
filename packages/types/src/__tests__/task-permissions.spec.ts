import { describe, it, expect } from "vitest"
import {
	mergeTaskPermissions,
	matchesAnyPattern,
	matchesAllPatternLayers,
	taskPermissionsSchema,
	toTaskPermissions,
	isSafeRegex,
} from "../task-permissions.js"
import { historyItemSchema } from "../history.js"
import type { TaskPermissions } from "../task-permissions.js"

describe("TaskPermissions", () => {
	describe("taskPermissionsSchema", () => {
		it("validates a valid permissions object", () => {
			const result = taskPermissionsSchema.safeParse({
				filePatterns: ["src/components/.*"],
				commandPatterns: ["npm test.*"],
				allowedTools: ["read_file", "write_to_file"],
				deniedTools: ["execute_command"],
			})
			expect(result.success).toBe(true)
		})

		it("validates an empty object", () => {
			const result = taskPermissionsSchema.safeParse({})
			expect(result.success).toBe(true)
		})

		it("validates partial permissions", () => {
			const result = taskPermissionsSchema.safeParse({
				filePatterns: ["src/.*"],
			})
			expect(result.success).toBe(true)
		})

		it("rejects non-string array values", () => {
			const result = taskPermissionsSchema.safeParse({
				filePatterns: [123],
			})
			expect(result.success).toBe(false)
		})

		it("rejects invalid regex patterns in filePatterns", () => {
			const result = taskPermissionsSchema.safeParse({
				filePatterns: ["[invalid"],
			})
			expect(result.success).toBe(false)
		})

		it("rejects invalid regex patterns in commandPatterns", () => {
			const result = taskPermissionsSchema.safeParse({
				commandPatterns: ["(unclosed"],
			})
			expect(result.success).toBe(false)
		})
	})

	describe("toTaskPermissions", () => {
		it("wraps flat filePatterns into a single layer", () => {
			const input = { filePatterns: ["src/.*"] }
			const result = toTaskPermissions(input)
			expect(result._filePatternLayers).toEqual([["src/.*"]])
			expect(result.filePatterns).toEqual(["src/.*"])
		})

		it("wraps flat commandPatterns into a single layer", () => {
			const input = { commandPatterns: ["npm test.*"] }
			const result = toTaskPermissions(input)
			expect(result._commandPatternLayers).toEqual([["npm test.*"]])
		})

		it("leaves layers undefined when patterns are not set", () => {
			const input = { allowedTools: ["read_file"] }
			const result = toTaskPermissions(input)
			expect(result._filePatternLayers).toBeUndefined()
			expect(result._commandPatternLayers).toBeUndefined()
		})
	})

	describe("mergeTaskPermissions", () => {
		it("returns undefined when both are undefined", () => {
			expect(mergeTaskPermissions(undefined, undefined)).toBeUndefined()
		})

		it("returns child when parent is undefined", () => {
			const child: TaskPermissions = { filePatterns: ["src/.*"] }
			expect(mergeTaskPermissions(undefined, child)).toEqual(child)
		})

		it("returns parent when child is undefined", () => {
			const parent: TaskPermissions = { filePatterns: ["src/.*"] }
			expect(mergeTaskPermissions(parent, undefined)).toEqual(parent)
		})

		it("accumulates filePatterns as separate layers when both defined", () => {
			const parent = toTaskPermissions({ filePatterns: ["src/.*", "tests/.*"] })
			const child = toTaskPermissions({ filePatterns: ["src/.*", "docs/.*"] })
			const merged = mergeTaskPermissions(parent, child)
			// Both layers are kept (AND semantics between layers)
			expect(merged?._filePatternLayers).toEqual([
				["src/.*", "tests/.*"],
				["src/.*", "docs/.*"],
			])
		})

		it("accumulates commandPatterns as separate layers when both defined", () => {
			const parent = toTaskPermissions({ commandPatterns: ["npm test.*", "npm run lint"] })
			const child = toTaskPermissions({ commandPatterns: ["npm test.*", "npm run build"] })
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?._commandPatternLayers).toEqual([
				["npm test.*", "npm run lint"],
				["npm test.*", "npm run build"],
			])
		})

		it("intersects allowedTools when both defined", () => {
			const parent: TaskPermissions = { allowedTools: ["read_file", "write_to_file", "search_files"] }
			const child: TaskPermissions = { allowedTools: ["read_file", "execute_command"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.allowedTools).toEqual(["read_file"])
		})

		it("unions deniedTools when both defined", () => {
			const parent: TaskPermissions = { deniedTools: ["execute_command"] }
			const child: TaskPermissions = { deniedTools: ["write_to_file"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.deniedTools).toEqual(["execute_command", "write_to_file"])
		})

		it("deduplicates deniedTools in union", () => {
			const parent: TaskPermissions = { deniedTools: ["execute_command", "write_to_file"] }
			const child: TaskPermissions = { deniedTools: ["execute_command", "search_files"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.deniedTools).toEqual(["execute_command", "write_to_file", "search_files"])
		})

		it("uses parent filePatterns when child has none", () => {
			const parent = toTaskPermissions({ filePatterns: ["src/.*"] })
			const child: TaskPermissions = { deniedTools: ["execute_command"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?._filePatternLayers).toEqual([["src/.*"]])
			expect(merged?.deniedTools).toEqual(["execute_command"])
		})

		it("returns empty array when allowedTools intersection is empty", () => {
			const parent: TaskPermissions = { allowedTools: ["read_file"] }
			const child: TaskPermissions = { allowedTools: ["write_to_file"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.allowedTools).toEqual([])
		})

		it("handles nested delegation where child narrows scope", () => {
			const grandparent = toTaskPermissions({
				filePatterns: ["src/.*"],
				commandPatterns: ["npm.*"],
				allowedTools: ["read_file", "write_to_file", "search_files"],
				deniedTools: ["execute_command"],
			})
			const parent = toTaskPermissions({
				filePatterns: ["src/components/.*"],
				allowedTools: ["read_file", "write_to_file"],
			})

			const merged = mergeTaskPermissions(grandparent, parent)

			// Both layers are kept -- runtime enforces AND between them
			expect(merged?._filePatternLayers).toEqual([["src/.*"], ["src/components/.*"]])
			// allowedTools intersection: read_file and write_to_file are in both
			expect(merged?.allowedTools).toEqual(["read_file", "write_to_file"])
			// commandPatterns: only grandparent has them, so they pass through
			expect(merged?._commandPatternLayers).toEqual([["npm.*"]])
			// deniedTools: only grandparent has them, so they pass through
			expect(merged?.deniedTools).toEqual(["execute_command"])
		})

		it("deduplicates identical pattern layers", () => {
			const parent = toTaskPermissions({ filePatterns: ["src/.*"] })
			const child = toTaskPermissions({ filePatterns: ["src/.*"] })
			const merged = mergeTaskPermissions(parent, child)
			// Identical layers are deduplicated
			expect(merged?._filePatternLayers).toEqual([["src/.*"]])
		})
	})

	describe("matchesAnyPattern", () => {
		it("matches a simple regex pattern", () => {
			expect(matchesAnyPattern("src/components/Button.tsx", ["src/components/.*"])).toBe(true)
		})

		it("does not match when no patterns match", () => {
			expect(matchesAnyPattern("tests/unit/test.ts", ["src/components/.*"])).toBe(false)
		})

		it("matches when at least one pattern matches", () => {
			expect(matchesAnyPattern("tests/unit/test.ts", ["src/.*", "tests/.*"])).toBe(true)
		})

		it("handles invalid regex gracefully", () => {
			expect(matchesAnyPattern("test.ts", ["[invalid"])).toBe(false)
		})

		it("matches command patterns", () => {
			expect(matchesAnyPattern("npm test -- --coverage", ["npm test.*"])).toBe(true)
		})

		it("does not match restricted commands", () => {
			expect(matchesAnyPattern("rm -rf /", ["npm.*", "yarn.*"])).toBe(false)
		})

		it("anchors patterns so substrings do not match", () => {
			// "src/.*" should NOT match a path that merely contains "src/" as a substring
			expect(matchesAnyPattern("evil/src/components/foo.ts", ["src/.*"])).toBe(false)
			// But should still match paths that start with src/
			expect(matchesAnyPattern("src/components/foo.ts", ["src/.*"])).toBe(true)
		})

		it("respects pre-anchored patterns (starting with ^)", () => {
			// A pattern already starting with ^ should not be double-wrapped
			expect(matchesAnyPattern("src/foo.ts", ["^src/.*$"])).toBe(true)
			expect(matchesAnyPattern("evil/src/foo.ts", ["^src/.*$"])).toBe(false)
		})
	})

	describe("matchesAllPatternLayers", () => {
		it("returns true when layers is undefined", () => {
			expect(matchesAllPatternLayers("anything", undefined)).toBe(true)
		})

		it("returns true when layers is empty", () => {
			expect(matchesAllPatternLayers("anything", [])).toBe(true)
		})

		it("returns true when value matches all layers", () => {
			const layers = [["src/.*"], ["src/components/.*"]]
			expect(matchesAllPatternLayers("src/components/Button.tsx", layers)).toBe(true)
		})

		it("returns false when value fails to match one layer", () => {
			const layers = [["src/.*"], ["src/components/.*"]]
			// Matches src/.* but not src/components/.*
			expect(matchesAllPatternLayers("src/utils/helper.ts", layers)).toBe(false)
		})

		it("handles single layer like matchesAnyPattern", () => {
			const layers = [["src/.*", "tests/.*"]]
			expect(matchesAllPatternLayers("tests/unit/test.ts", layers)).toBe(true)
			expect(matchesAllPatternLayers("docs/readme.md", layers)).toBe(false)
		})
	})

	describe("isSafeRegex", () => {
		it("allows simple patterns", () => {
			expect(isSafeRegex("src/.*")).toBe(true)
			expect(isSafeRegex("^foo$")).toBe(true)
			expect(isSafeRegex("[a-z]+")).toBe(true)
			expect(isSafeRegex("npm\\s+test.*")).toBe(true)
			expect(isSafeRegex("src/components/.*\\.tsx?")).toBe(true)
		})

		it("rejects nested quantifiers (a+)+", () => {
			expect(isSafeRegex("(a+)+")).toBe(false)
		})

		it("rejects nested quantifiers (a*)*", () => {
			expect(isSafeRegex("(a*)*")).toBe(false)
		})

		it("rejects nested quantifiers (.*)+", () => {
			expect(isSafeRegex("(.*)+")).toBe(false)
		})

		it("rejects nested quantifiers with braces (a{1,})+", () => {
			expect(isSafeRegex("(a{1,})+")).toBe(false)
		})

		it("rejects star-height > 1 patterns like (.+)+", () => {
			expect(isSafeRegex("(.+)+")).toBe(false)
		})

		it("rejects star-height > 1 patterns like (\\w+)*", () => {
			expect(isSafeRegex("(\\w+)*")).toBe(false)
		})

		it("rejects patterns that exceed max length", () => {
			const longPattern = "a".repeat(501)
			expect(isSafeRegex(longPattern)).toBe(false)
		})

		it("allows patterns at max length", () => {
			const maxPattern = "a".repeat(500)
			expect(isSafeRegex(maxPattern)).toBe(true)
		})
	})

	describe("schema rejects unsafe regex", () => {
		it("rejects nested quantifiers in filePatterns", () => {
			const result = taskPermissionsSchema.safeParse({
				filePatterns: ["(a+)+"],
			})
			expect(result.success).toBe(false)
		})

		it("rejects nested quantifiers in commandPatterns", () => {
			const result = taskPermissionsSchema.safeParse({
				commandPatterns: ["(.*)+"],
			})
			expect(result.success).toBe(false)
		})

		it("allows safe regex in schema", () => {
			const result = taskPermissionsSchema.safeParse({
				filePatterns: ["src/components/.*\\.tsx?"],
				commandPatterns: ["npm\\s+test.*"],
			})
			expect(result.success).toBe(true)
		})
	})

	describe("matchesAnyPattern skips unsafe patterns at runtime", () => {
		it("skips unsafe pattern and does not match", () => {
			// (a+)+ is a ReDoS-prone pattern -- should be skipped
			expect(matchesAnyPattern("aaa", ["(a+)+"])).toBe(false)
		})

		it("still matches safe patterns alongside unsafe ones", () => {
			// The safe pattern "aaa" should still work
			expect(matchesAnyPattern("aaa", ["(a+)+", "aaa"])).toBe(true)
		})
	})

	describe("HistoryItem taskPermissions persistence", () => {
		it("accepts a HistoryItem with taskPermissions", () => {
			const result = historyItemSchema.safeParse({
				id: "test-task",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 50,
				totalCost: 0.01,
				taskPermissions: {
					filePatterns: ["src/.*"],
					commandPatterns: ["npm test.*"],
					allowedTools: ["read_file"],
					deniedTools: ["execute_command"],
				},
			})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.taskPermissions).toBeDefined()
				expect(result.data.taskPermissions?.filePatterns).toEqual(["src/.*"])
			}
		})

		it("accepts a HistoryItem without taskPermissions", () => {
			const result = historyItemSchema.safeParse({
				id: "test-task",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 50,
				totalCost: 0.01,
			})
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.taskPermissions).toBeUndefined()
			}
		})

		it("rejects HistoryItem with invalid taskPermissions regex", () => {
			const result = historyItemSchema.safeParse({
				id: "test-task",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 50,
				totalCost: 0.01,
				taskPermissions: {
					filePatterns: ["[invalid"],
				},
			})
			expect(result.success).toBe(false)
		})

		it("rejects HistoryItem with unsafe ReDoS patterns", () => {
			const result = historyItemSchema.safeParse({
				id: "test-task",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 50,
				totalCost: 0.01,
				taskPermissions: {
					filePatterns: ["(a+)+"],
				},
			})
			expect(result.success).toBe(false)
		})

		it("round-trips permissions through toTaskPermissions", () => {
			const input = {
				filePatterns: ["src/.*"],
				commandPatterns: ["npm.*"],
				allowedTools: ["read_file"],
				deniedTools: ["execute_command"],
			}
			const internal = toTaskPermissions(input)
			expect(internal._filePatternLayers).toEqual([["src/.*"]])
			expect(internal._commandPatternLayers).toEqual([["npm.*"]])
			// Serializable fields survive round-trip
			expect(internal.filePatterns).toEqual(input.filePatterns)
			expect(internal.commandPatterns).toEqual(input.commandPatterns)
			expect(internal.allowedTools).toEqual(input.allowedTools)
			expect(internal.deniedTools).toEqual(input.deniedTools)
		})
	})
})
