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
})
