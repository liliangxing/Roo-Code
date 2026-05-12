import { describe, it, expect } from "vitest"
import { mergeTaskPermissions, matchesAnyPattern, taskPermissionsSchema } from "../task-permissions.js"
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

		it("intersects filePatterns when both defined", () => {
			const parent: TaskPermissions = { filePatterns: ["src/.*", "tests/.*"] }
			const child: TaskPermissions = { filePatterns: ["src/.*", "docs/.*"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.filePatterns).toEqual(["src/.*"])
		})

		it("intersects commandPatterns when both defined", () => {
			const parent: TaskPermissions = { commandPatterns: ["npm test.*", "npm run lint"] }
			const child: TaskPermissions = { commandPatterns: ["npm test.*", "npm run build"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.commandPatterns).toEqual(["npm test.*"])
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
			const parent: TaskPermissions = { filePatterns: ["src/.*"] }
			const child: TaskPermissions = { deniedTools: ["execute_command"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.filePatterns).toEqual(["src/.*"])
			expect(merged?.deniedTools).toEqual(["execute_command"])
		})

		it("returns empty array when intersection is empty", () => {
			const parent: TaskPermissions = { allowedTools: ["read_file"] }
			const child: TaskPermissions = { allowedTools: ["write_to_file"] }
			const merged = mergeTaskPermissions(parent, child)
			expect(merged?.allowedTools).toEqual([])
		})

		it("handles complex nested merge scenario with exact string matching", () => {
			const grandparent: TaskPermissions = {
				filePatterns: ["src/.*"],
				commandPatterns: ["npm.*"],
				allowedTools: ["read_file", "write_to_file", "search_files"],
				deniedTools: ["execute_command"],
			}
			const parent: TaskPermissions = {
				filePatterns: ["src/components/.*"],
				allowedTools: ["read_file", "write_to_file"],
			}

			// Intersection uses exact string matching, so "src/components/.*" (child)
			// is not equal to "src/.*" (parent) -- intersection is empty
			const merged1 = mergeTaskPermissions(grandparent, parent)
			expect(merged1?.filePatterns).toEqual([])
			// allowedTools intersection: read_file and write_to_file are in both
			expect(merged1?.allowedTools).toEqual(["read_file", "write_to_file"])
			// commandPatterns: only grandparent has them, so they pass through
			expect(merged1?.commandPatterns).toEqual(["npm.*"])
			// deniedTools: only grandparent has them, so they pass through
			expect(merged1?.deniedTools).toEqual(["execute_command"])
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
	})
})
