import {
	BackgroundTaskRunner,
	DEFAULT_MAX_BACKGROUND_TASKS,
	DEFAULT_BACKGROUND_TASK_TIMEOUT_MS,
} from "../BackgroundTaskRunner"

// Minimal mock for Task
function createMockTask(taskId: string): any {
	return {
		taskId,
		instanceId: "test-instance",
		isBackgroundTask: true,
		abortTask: vi.fn().mockResolvedValue(undefined),
	}
}

describe("BackgroundTaskRunner", () => {
	let runner: BackgroundTaskRunner

	beforeEach(() => {
		vi.useFakeTimers()
		runner = new BackgroundTaskRunner()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("constructor", () => {
		it("should initialize with default values", () => {
			expect(runner.activeCount).toBe(0)
			expect(runner.canAcceptTask).toBe(true)
		})

		it("should accept custom concurrency and timeout", () => {
			const customRunner = new BackgroundTaskRunner(5, 60000)
			expect(customRunner.canAcceptTask).toBe(true)
		})
	})

	describe("registerTask", () => {
		it("should register a background task", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			expect(runner.activeCount).toBe(1)
			expect(runner.isBackgroundTask("task-1")).toBe(true)
		})

		it("should track parent task ID", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			const info = runner.getTaskInfo("task-1")
			expect(info).toBeDefined()
			expect(info!.parentTaskId).toBe("parent-1")
		})

		it("should not register duplicate tasks", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")
			runner.registerTask(task, "parent-1") // duplicate

			expect(runner.activeCount).toBe(1)
		})

		it("should throw when concurrency limit is reached", () => {
			const customRunner = new BackgroundTaskRunner(2)

			customRunner.registerTask(createMockTask("task-1"), "parent-1")
			customRunner.registerTask(createMockTask("task-2"), "parent-1")

			expect(() => {
				customRunner.registerTask(createMockTask("task-3"), "parent-1")
			}).toThrow("Cannot accept more background tasks")
		})

		it("should report canAcceptTask correctly", () => {
			const customRunner = new BackgroundTaskRunner(2)

			expect(customRunner.canAcceptTask).toBe(true)
			customRunner.registerTask(createMockTask("task-1"), "parent-1")
			expect(customRunner.canAcceptTask).toBe(true)
			customRunner.registerTask(createMockTask("task-2"), "parent-1")
			expect(customRunner.canAcceptTask).toBe(false)
		})
	})

	describe("onTaskCompleted", () => {
		it("should remove completed task and return info", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			const info = runner.onTaskCompleted("task-1")

			expect(info).toBeDefined()
			expect(info!.parentTaskId).toBe("parent-1")
			expect(runner.activeCount).toBe(0)
			expect(runner.isBackgroundTask("task-1")).toBe(false)
		})

		it("should return undefined for unknown task", () => {
			const info = runner.onTaskCompleted("unknown")
			expect(info).toBeUndefined()
		})

		it("should clear the timeout on completion", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")
			runner.onTaskCompleted("task-1")

			// Advance time past the timeout - should not trigger abort
			vi.advanceTimersByTime(DEFAULT_BACKGROUND_TASK_TIMEOUT_MS + 1000)
			expect(task.abortTask).not.toHaveBeenCalled()
		})
	})

	describe("cancelTask", () => {
		it("should abort and remove a task", async () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			await runner.cancelTask("task-1")

			expect(task.abortTask).toHaveBeenCalledWith(true)
			expect(runner.activeCount).toBe(0)
		})

		it("should handle canceling unknown task gracefully", async () => {
			await runner.cancelTask("unknown") // should not throw
		})

		it("should invoke onTaskError callback when abort throws", async () => {
			const onTaskError = vi.fn()
			const customRunner = new BackgroundTaskRunner(3, undefined, { onTaskError })
			const task = createMockTask("task-1")
			task.abortTask.mockRejectedValue(new Error("abort failed"))
			customRunner.registerTask(task, "parent-1")

			await customRunner.cancelTask("task-1")

			expect(onTaskError).toHaveBeenCalledWith("task-1", "parent-1", expect.any(Error))
			expect(customRunner.activeCount).toBe(0)
		})
	})

	describe("cancelTasksByParent", () => {
		it("should cancel all tasks for a given parent", async () => {
			const task1 = createMockTask("task-1")
			const task2 = createMockTask("task-2")
			const task3 = createMockTask("task-3")

			runner.registerTask(task1, "parent-1")
			runner.registerTask(task2, "parent-1")
			runner.registerTask(task3, "parent-2")

			await runner.cancelTasksByParent("parent-1")

			expect(task1.abortTask).toHaveBeenCalled()
			expect(task2.abortTask).toHaveBeenCalled()
			expect(task3.abortTask).not.toHaveBeenCalled()
			expect(runner.activeCount).toBe(1)
		})
	})

	describe("timeout", () => {
		it("should abort task after timeout", async () => {
			const task = createMockTask("task-1")
			const customRunner = new BackgroundTaskRunner(3, 5000)
			customRunner.registerTask(task, "parent-1")

			vi.advanceTimersByTime(5000)

			// Allow any pending microtasks to flush
			await vi.runAllTimersAsync()

			expect(task.abortTask).toHaveBeenCalledWith(true)
			expect(customRunner.activeCount).toBe(0)
		})

		it("should invoke onTaskTimeout callback when task times out", async () => {
			const onTaskTimeout = vi.fn()
			const customRunner = new BackgroundTaskRunner(3, 5000, { onTaskTimeout })
			const task = createMockTask("task-1")
			customRunner.registerTask(task, "parent-1")

			vi.advanceTimersByTime(5000)
			await vi.runAllTimersAsync()

			expect(onTaskTimeout).toHaveBeenCalledWith("task-1", "parent-1")
		})
	})

	describe("dispose", () => {
		it("should cancel all tasks", async () => {
			const task1 = createMockTask("task-1")
			const task2 = createMockTask("task-2")

			runner.registerTask(task1, "parent-1")
			runner.registerTask(task2, "parent-2")

			await runner.dispose()

			expect(task1.abortTask).toHaveBeenCalled()
			expect(task2.abortTask).toHaveBeenCalled()
			expect(runner.activeCount).toBe(0)
		})
	})

	describe("getTaskInfo", () => {
		it("should return task info for registered task", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			const info = runner.getTaskInfo("task-1")
			expect(info).toBeDefined()
			expect(info!.task).toBe(task)
			expect(info!.parentTaskId).toBe("parent-1")
			expect(info!.startedAt).toBeGreaterThan(0)
		})

		it("should return undefined for unregistered task", () => {
			expect(runner.getTaskInfo("unknown")).toBeUndefined()
		})
	})

	describe("getTasksStatus", () => {
		it("should return empty array when no tasks", () => {
			expect(runner.getTasksStatus()).toEqual([])
		})

		it("should return running tasks with correct status", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			const statuses = runner.getTasksStatus()
			expect(statuses).toHaveLength(1)
			expect(statuses[0].taskId).toBe("task-1")
			expect(statuses[0].parentTaskId).toBe("parent-1")
			expect(statuses[0].status).toBe("running")
			expect(statuses[0].startedAt).toBeGreaterThan(0)
			expect(statuses[0].completedAt).toBeUndefined()
		})

		it("should include completed tasks after onTaskCompleted", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")
			runner.onTaskCompleted("task-1", "Done!")

			const statuses = runner.getTasksStatus()
			expect(statuses).toHaveLength(1)
			expect(statuses[0].taskId).toBe("task-1")
			expect(statuses[0].status).toBe("completed")
			expect(statuses[0].resultSummary).toBe("Done!")
			expect(statuses[0].completedAt).toBeGreaterThan(0)
		})

		it("should include cancelled tasks after cancelTask", async () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")
			await runner.cancelTask("task-1")

			const statuses = runner.getTasksStatus()
			expect(statuses).toHaveLength(1)
			expect(statuses[0].status).toBe("cancelled")
		})

		it("should show both active and completed tasks", () => {
			const task1 = createMockTask("task-1")
			const task2 = createMockTask("task-2")
			runner.registerTask(task1, "parent-1")
			runner.registerTask(task2, "parent-1")
			runner.onTaskCompleted("task-1", "Result 1")

			const statuses = runner.getTasksStatus()
			expect(statuses).toHaveLength(2)
			// Active task
			const active = statuses.find((s) => s.taskId === "task-2")
			expect(active?.status).toBe("running")
			// Completed task
			const completed = statuses.find((s) => s.taskId === "task-1")
			expect(completed?.status).toBe("completed")
		})
	})

	describe("completed tasks buffer", () => {
		it("should limit completed tasks to MAX_COMPLETED_TASKS (10)", () => {
			// Register and complete 12 tasks
			for (let i = 0; i < 12; i++) {
				const task = createMockTask(`task-${i}`)
				runner.registerTask(task, "parent-1")
				runner.onTaskCompleted(`task-${i}`, `Result ${i}`)
			}

			const completed = runner.getCompletedTasks()
			expect(completed).toHaveLength(10)
			// Should keep the most recent 10
			expect(completed[0].taskId).toBe("task-2")
			expect(completed[9].taskId).toBe("task-11")
		})

		it("should clear completed tasks", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")
			runner.onTaskCompleted("task-1", "Done")

			expect(runner.getCompletedTasks()).toHaveLength(1)
			runner.clearCompletedTasks()
			expect(runner.getCompletedTasks()).toHaveLength(0)
		})
	})

	describe("onStateChanged callback", () => {
		it("should be called when a task is registered", () => {
			const callback = vi.fn()
			runner.onStateChanged = callback

			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			expect(callback).toHaveBeenCalledTimes(1)
		})

		it("should be called when a task is completed", () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			const callback = vi.fn()
			runner.onStateChanged = callback
			runner.onTaskCompleted("task-1", "Done")

			expect(callback).toHaveBeenCalledTimes(1)
		})

		it("should be called when a task is cancelled", async () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			const callback = vi.fn()
			runner.onStateChanged = callback
			await runner.cancelTask("task-1")

			expect(callback).toHaveBeenCalledTimes(1)
		})

		it("should not throw if onStateChanged is not set", () => {
			const task = createMockTask("task-1")
			runner.onStateChanged = undefined
			expect(() => runner.registerTask(task, "parent-1")).not.toThrow()
		})
	})

	describe("timeout tracking", () => {
		it("should record timed_out status when task times out", async () => {
			const task = createMockTask("task-1")
			runner.registerTask(task, "parent-1")

			// Advance past timeout
			vi.advanceTimersByTime(DEFAULT_BACKGROUND_TASK_TIMEOUT_MS + 1000)

			// Wait for async timeoutTask
			await vi.runAllTimersAsync()

			const statuses = runner.getTasksStatus()
			const timedOut = statuses.find((s) => s.taskId === "task-1")
			expect(timedOut?.status).toBe("timed_out")
		})
	})
})
