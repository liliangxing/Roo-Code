import { z } from "zod"

/**
 * SubtaskQueueItem — a single queued subtask definition for sequential fan-out.
 * Used by the orchestrator to define a pipeline of subtasks that execute one after another.
 */
export const subtaskQueueItemSchema = z.object({
	mode: z.string(),
	message: z.string(),
})

export type SubtaskQueueItem = z.infer<typeof subtaskQueueItemSchema>

/**
 * SubtaskResult — the result of a completed subtask in a queue.
 */
export const subtaskResultSchema = z.object({
	taskId: z.string(),
	mode: z.string(),
	summary: z.string(),
})

export type SubtaskResult = z.infer<typeof subtaskResultSchema>

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	status: z.enum(["active", "completed", "delegated"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	// Sequential fan-out queue (Phase 2)
	subtaskQueue: z.array(subtaskQueueItemSchema).optional(), // Remaining subtasks to execute
	subtaskQueueIndex: z.number().optional(), // Current position in the original queue (0-based)
	subtaskResults: z.array(subtaskResultSchema).optional(), // Results from completed queue subtasks
})

export type HistoryItem = z.infer<typeof historyItemSchema>
