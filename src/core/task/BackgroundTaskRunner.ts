/**
 * BackgroundTaskRunner manages read-only background tasks that run concurrently
 * alongside the user's active foreground task. Background tasks:
 * - Are completely webview-silent (no UI updates)
 * - Auto-approve all tool uses (no user interaction)
 * - Are restricted to read-only tools only
 * - Have a configurable timeout to prevent runaway execution
 * - Are not added to the clineStack
 *
 * This is Phase 4 of the parallel execution roadmap: Background Read-Only Concurrency.
 */

import { BackgroundTaskStatusInfo } from "@roo-code/types"

import { Task, TaskOptions } from "./Task"

/** Read-only tools that background tasks are allowed to use. */
export const BACKGROUND_TASK_ALLOWED_TOOLS = [
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"ask_followup_question",
	"attempt_completion",
] as const

/** Default maximum number of concurrent background tasks. */
export const DEFAULT_MAX_BACKGROUND_TASKS = 3

/** Default timeout for background tasks in milliseconds (5 minutes). */
export const DEFAULT_BACKGROUND_TASK_TIMEOUT_MS = 5 * 60 * 1000

export interface BackgroundTaskInfo {
	task: Task
	parentTaskId: string
	startedAt: number
	timeoutHandle: ReturnType<typeof setTimeout>
}

/**
 * Optional callbacks that allow the owner (e.g. ClineProvider) to react to
 * background task lifecycle events such as completion, timeout, or errors.
 */
export interface BackgroundTaskRunnerCallbacks {
	/** Called when a background task times out. */
	onTaskTimeout?: (taskId: string, parentTaskId: string) => void
	/** Called when aborting a background task throws an error. */
	onTaskError?: (taskId: string, parentTaskId: string, error: Error) => void
}

/** Maximum number of recently completed tasks to keep for UI display. */
const MAX_COMPLETED_TASKS = 10

export interface CompletedBackgroundTaskInfo {
	taskId: string
	parentTaskId: string
	status: "completed" | "cancelled" | "timed_out" | "error"
	startedAt: number
	completedAt: number
	resultSummary?: string
	mode?: string
}

export class BackgroundTaskRunner {
	private backgroundTasks: Map<string, BackgroundTaskInfo> = new Map()
	private completedTasks: CompletedBackgroundTaskInfo[] = []
	private maxConcurrentTasks: number
	private taskTimeoutMs: number
	private callbacks: BackgroundTaskRunnerCallbacks
	/** Called whenever the set of active/completed tasks changes, so the UI can be refreshed. */
	public onStateChanged?: () => void

	constructor(
		maxConcurrentTasks: number = DEFAULT_MAX_BACKGROUND_TASKS,
		taskTimeoutMs: number = DEFAULT_BACKGROUND_TASK_TIMEOUT_MS,
		callbacks: BackgroundTaskRunnerCallbacks = {},
	) {
		this.maxConcurrentTasks = maxConcurrentTasks
		this.taskTimeoutMs = taskTimeoutMs
		this.callbacks = callbacks
	}

	/**
	 * Returns the number of currently running background tasks.
	 */
	get activeCount(): number {
		return this.backgroundTasks.size
	}

	/**
	 * Returns whether the runner can accept more background tasks.
	 */
	get canAcceptTask(): boolean {
		return this.backgroundTasks.size < this.maxConcurrentTasks
	}

	/**
	 * Register a background task after it has been created.
	 * The task should already have isBackgroundTask=true and be started.
	 */
	registerTask(task: Task, parentTaskId: string): void {
		if (this.backgroundTasks.has(task.taskId)) {
			console.warn(`[BackgroundTaskRunner] Task ${task.taskId} already registered`)
			return
		}

		if (!this.canAcceptTask) {
			throw new Error(
				`[BackgroundTaskRunner] Cannot accept more background tasks. ` +
					`Current: ${this.backgroundTasks.size}, Max: ${this.maxConcurrentTasks}`,
			)
		}

		const timeoutHandle = setTimeout(() => {
			this.timeoutTask(task.taskId)
		}, this.taskTimeoutMs)

		this.backgroundTasks.set(task.taskId, {
			task,
			parentTaskId,
			startedAt: Date.now(),
			timeoutHandle,
		})

		console.log(
			`[BackgroundTaskRunner] Registered background task ${task.taskId} ` +
				`(parent: ${parentTaskId}, active: ${this.backgroundTasks.size}/${this.maxConcurrentTasks})`,
		)

		this.notifyStateChanged()
	}

	/**
	 * Called when a background task completes. Cleans up tracking state.
	 */
	onTaskCompleted(taskId: string, resultSummary?: string): BackgroundTaskInfo | undefined {
		const info = this.backgroundTasks.get(taskId)

		if (!info) {
			return undefined
		}

		clearTimeout(info.timeoutHandle)
		this.backgroundTasks.delete(taskId)

		this.addCompletedTask({
			taskId,
			parentTaskId: info.parentTaskId,
			status: "completed",
			startedAt: info.startedAt,
			completedAt: Date.now(),
			resultSummary,
		})

		console.log(
			`[BackgroundTaskRunner] Background task ${taskId} completed ` +
				`(active: ${this.backgroundTasks.size}/${this.maxConcurrentTasks})`,
		)

		this.notifyStateChanged()

		return info
	}

	/**
	 * Get info about a specific background task.
	 */
	getTaskInfo(taskId: string): BackgroundTaskInfo | undefined {
		return this.backgroundTasks.get(taskId)
	}

	/**
	 * Check if a task is a registered background task.
	 */
	isBackgroundTask(taskId: string): boolean {
		return this.backgroundTasks.has(taskId)
	}

	/**
	 * Cancel all background tasks spawned by a specific parent task.
	 */
	async cancelTasksByParent(parentTaskId: string): Promise<void> {
		const tasksToCancel: BackgroundTaskInfo[] = []

		for (const [, info] of this.backgroundTasks) {
			if (info.parentTaskId === parentTaskId) {
				tasksToCancel.push(info)
			}
		}

		for (const info of tasksToCancel) {
			await this.cancelTask(info.task.taskId)
		}
	}

	/**
	 * Cancel a specific background task.
	 */
	async cancelTask(taskId: string): Promise<void> {
		const info = this.backgroundTasks.get(taskId)

		if (!info) {
			return
		}

		clearTimeout(info.timeoutHandle)

		let status: CompletedBackgroundTaskInfo["status"] = "cancelled"

		try {
			await info.task.abortTask(true)
		} catch (error) {
			status = "error"
			const err = error instanceof Error ? error : new Error(String(error))
			console.error(`[BackgroundTaskRunner] Error aborting background task ${taskId}: ${err.message}`)
			try {
				this.callbacks.onTaskError?.(taskId, info.parentTaskId, err)
			} catch {
				// Callback errors must not break cleanup.
			}
		}

		this.backgroundTasks.delete(taskId)

		this.addCompletedTask({
			taskId,
			parentTaskId: info.parentTaskId,
			status,
			startedAt: info.startedAt,
			completedAt: Date.now(),
		})

		console.log(
			`[BackgroundTaskRunner] Cancelled background task ${taskId} ` +
				`(active: ${this.backgroundTasks.size}/${this.maxConcurrentTasks})`,
		)

		this.notifyStateChanged()
	}

	/**
	 * Cancel all background tasks. Called during provider disposal.
	 */
	async dispose(): Promise<void> {
		const taskIds = Array.from(this.backgroundTasks.keys())

		for (const taskId of taskIds) {
			await this.cancelTask(taskId)
		}
	}

	/**
	 * Returns the combined status of all active and recently completed background tasks
	 * for display in the webview UI.
	 */
	getTasksStatus(): BackgroundTaskStatusInfo[] {
		const activeTasks: BackgroundTaskStatusInfo[] = []

		for (const [taskId, info] of this.backgroundTasks) {
			activeTasks.push({
				taskId,
				parentTaskId: info.parentTaskId,
				status: "running",
				startedAt: info.startedAt,
			})
		}

		const completedStatuses: BackgroundTaskStatusInfo[] = this.completedTasks.map((ct) => ({
			taskId: ct.taskId,
			parentTaskId: ct.parentTaskId,
			status: ct.status,
			startedAt: ct.startedAt,
			completedAt: ct.completedAt,
			resultSummary: ct.resultSummary,
			mode: ct.mode,
		}))

		return [...activeTasks, ...completedStatuses]
	}

	/**
	 * Returns the list of recently completed tasks (for testing and direct access).
	 */
	getCompletedTasks(): readonly CompletedBackgroundTaskInfo[] {
		return this.completedTasks
	}

	/**
	 * Clears completed tasks from the buffer.
	 */
	clearCompletedTasks(): void {
		this.completedTasks = []
		this.notifyStateChanged()
	}

	/**
	 * Add a completed task to the buffer, evicting the oldest if at capacity.
	 */
	private addCompletedTask(info: CompletedBackgroundTaskInfo): void {
		this.completedTasks.push(info)

		if (this.completedTasks.length > MAX_COMPLETED_TASKS) {
			this.completedTasks = this.completedTasks.slice(-MAX_COMPLETED_TASKS)
		}
	}

	/**
	 * Notify the owner that background task state has changed.
	 */
	private notifyStateChanged(): void {
		try {
			this.onStateChanged?.()
		} catch {
			// Callback errors must not break internal logic.
		}
	}

	/**
	 * Handle timeout of a background task.
	 */
	private async timeoutTask(taskId: string): Promise<void> {
		const info = this.backgroundTasks.get(taskId)
		const parentTaskId = info?.parentTaskId ?? "unknown"
		const startedAt = info?.startedAt ?? Date.now()

		console.warn(`[BackgroundTaskRunner] Background task ${taskId} timed out after ${this.taskTimeoutMs}ms`)

		try {
			this.callbacks.onTaskTimeout?.(taskId, parentTaskId)
		} catch {
			// Callback errors must not break cleanup.
		}

		// Record as timed_out before cancelling (cancelTask will record as cancelled otherwise)
		clearTimeout(info?.timeoutHandle)
		if (info) {
			try {
				await info.task.abortTask(true)
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error))
				console.error(`[BackgroundTaskRunner] Error aborting timed-out task ${taskId}: ${err.message}`)
			}
			this.backgroundTasks.delete(taskId)

			this.addCompletedTask({
				taskId,
				parentTaskId,
				status: "timed_out",
				startedAt,
				completedAt: Date.now(),
			})

			this.notifyStateChanged()
		} else {
			await this.cancelTask(taskId)
		}
	}
}
