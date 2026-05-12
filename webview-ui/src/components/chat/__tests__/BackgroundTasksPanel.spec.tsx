import { render, screen, fireEvent } from "@testing-library/react"

import { vscode } from "@src/utils/vscode"

import type { BackgroundTaskStatusInfo } from "@roo-code/types"

// Mock vscode
vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

// Mock useExtensionState
const mockBackgroundTasks: BackgroundTaskStatusInfo[] = []
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundTasks: mockBackgroundTasks,
	}),
}))

import BackgroundTasksPanel from "../BackgroundTasksPanel"

describe("BackgroundTasksPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockBackgroundTasks.length = 0
	})

	it("should not render when there are no background tasks", () => {
		const { container } = render(<BackgroundTasksPanel />)
		expect(container.innerHTML).toBe("")
	})

	it("should render when there are background tasks", () => {
		mockBackgroundTasks.push({
			taskId: "task-abc12345",
			parentTaskId: "parent-1",
			status: "running",
			startedAt: Date.now() - 30000,
		})

		render(<BackgroundTasksPanel />)
		expect(screen.getByText("Background Tasks")).toBeDefined()
		expect(screen.getByText("task-abc")).toBeDefined() // short ID
	})

	it("should show active count badge", () => {
		mockBackgroundTasks.push(
			{
				taskId: "task-1111",
				parentTaskId: "parent-1",
				status: "running",
				startedAt: Date.now(),
			},
			{
				taskId: "task-2222",
				parentTaskId: "parent-1",
				status: "completed",
				startedAt: Date.now() - 60000,
				completedAt: Date.now(),
				resultSummary: "Done",
			},
		)

		render(<BackgroundTasksPanel />)
		// Badge should show "1" for 1 running task
		expect(screen.getByText("1")).toBeDefined()
		expect(screen.getByText("2 total")).toBeDefined()
	})

	it("should show cancel button for running tasks", () => {
		mockBackgroundTasks.push({
			taskId: "task-run1",
			parentTaskId: "parent-1",
			status: "running",
			startedAt: Date.now(),
		})

		render(<BackgroundTasksPanel />)
		const cancelButton = screen.getByTitle("Cancel background task")
		expect(cancelButton).toBeDefined()
	})

	it("should require two clicks to cancel (confirmation pattern)", () => {
		mockBackgroundTasks.push({
			taskId: "task-cancel-me",
			parentTaskId: "parent-1",
			status: "running",
			startedAt: Date.now(),
		})

		render(<BackgroundTasksPanel />)
		const cancelButton = screen.getByTitle("Cancel background task")

		// First click shows confirmation text, does NOT send message
		fireEvent.click(cancelButton)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByText("Cancel?")).toBeDefined()

		// Second click confirms and sends the cancel message
		const confirmButton = screen.getByTitle("Click again to confirm cancellation")
		fireEvent.click(confirmButton)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "cancelBackgroundTask",
			taskId: "task-cancel-me",
		})
	})

	it("should show Result button for completed tasks with result summary", () => {
		mockBackgroundTasks.push({
			taskId: "task-done1",
			parentTaskId: "parent-1",
			status: "completed",
			startedAt: Date.now() - 60000,
			completedAt: Date.now(),
			resultSummary: "Analysis complete: found 3 issues.",
		})

		render(<BackgroundTasksPanel />)
		const resultButton = screen.getByText("Result")
		expect(resultButton).toBeDefined()

		// Click to expand
		fireEvent.click(resultButton)
		expect(screen.getByText("Analysis complete: found 3 issues.")).toBeDefined()

		// Click to collapse
		fireEvent.click(screen.getByText("Hide"))
		expect(screen.queryByText("Analysis complete: found 3 issues.")).toBeNull()
	})

	it("should collapse and expand the panel", () => {
		mockBackgroundTasks.push({
			taskId: "task-1234",
			parentTaskId: "parent-1",
			status: "running",
			startedAt: Date.now(),
		})

		render(<BackgroundTasksPanel />)
		const header = screen.getByText("Background Tasks")

		// Click to collapse
		fireEvent.click(header)
		expect(screen.queryByText("task-1234".slice(0, 8))).toBeNull()

		// Click to expand
		fireEvent.click(header)
		expect(screen.getByText("task-1234".slice(0, 8))).toBeDefined()
	})
})
