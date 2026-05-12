import React, { useState, useCallback, useMemo } from "react"

import type { BackgroundTaskStatusInfo } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

/**
 * Format elapsed time in a human-readable way.
 */
function formatElapsed(startedAt: number, completedAt?: number): string {
	const end = completedAt ?? Date.now()
	const ms = end - startedAt

	if (ms < 1000) {
		return "<1s"
	}

	const seconds = Math.floor(ms / 1000)

	if (seconds < 60) {
		return `${seconds}s`
	}

	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	return `${minutes}m ${remainingSeconds}s`
}

/**
 * Get a status icon codicon class based on task status.
 */
function getStatusIcon(status: BackgroundTaskStatusInfo["status"]): string {
	switch (status) {
		case "running":
			return "codicon-loading codicon-modifier-spin"
		case "completed":
			return "codicon-check"
		case "cancelled":
			return "codicon-circle-slash"
		case "timed_out":
			return "codicon-clock"
		case "error":
			return "codicon-error"
		default:
			return "codicon-question"
	}
}

/**
 * Get a color class for the status indicator.
 */
function getStatusColor(status: BackgroundTaskStatusInfo["status"]): string {
	switch (status) {
		case "running":
			return "text-vscode-charts-blue"
		case "completed":
			return "text-vscode-charts-green"
		case "cancelled":
			return "text-vscode-charts-yellow"
		case "timed_out":
			return "text-vscode-charts-orange"
		case "error":
			return "text-vscode-errorForeground"
		default:
			return "text-vscode-descriptionForeground"
	}
}

function BackgroundTaskItem({ task }: { task: BackgroundTaskStatusInfo }) {
	const [showResult, setShowResult] = useState(false)
	const [confirmingCancel, setConfirmingCancel] = useState(false)
	const isRunning = task.status === "running"

	const handleCancelClick = useCallback(() => {
		if (!confirmingCancel) {
			setConfirmingCancel(true)
			// Auto-reset after 3 seconds if user doesn't confirm
			setTimeout(() => setConfirmingCancel(false), 3000)
			return
		}
		// Second click confirms cancellation
		setConfirmingCancel(false)
		vscode.postMessage({ type: "cancelBackgroundTask", taskId: task.taskId })
	}, [confirmingCancel, task.taskId])

	const shortId = task.taskId.slice(0, 8)

	return (
		<div className="flex flex-col border border-vscode-panel-border rounded px-2 py-1.5 mb-1 last:mb-0">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1.5 min-w-0 flex-1">
					<span
						className={`codicon ${getStatusIcon(task.status)} ${getStatusColor(task.status)} flex-shrink-0`}
					/>
					<span className="text-xs text-vscode-foreground truncate" title={task.taskId}>
						{shortId}
					</span>
					<span className="text-xs text-vscode-descriptionForeground flex-shrink-0">
						{formatElapsed(task.startedAt, task.completedAt)}
					</span>
				</div>
				<div className="flex items-center gap-1 flex-shrink-0">
					{task.resultSummary && !isRunning && (
						<button
							className="text-xs text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground cursor-pointer bg-transparent border-none p-0"
							onClick={() => setShowResult(!showResult)}
							title="Toggle result">
							{showResult ? "Hide" : "Result"}
						</button>
					)}
					{isRunning && (
						<button
							className={`text-xs cursor-pointer bg-transparent border-none p-0 flex items-center gap-0.5 ${
								confirmingCancel
									? "text-vscode-errorForeground font-medium"
									: "text-vscode-errorForeground hover:opacity-80"
							}`}
							onClick={handleCancelClick}
							title={confirmingCancel ? "Click again to confirm cancellation" : "Cancel background task"}>
							{confirmingCancel ? (
								<span>Cancel?</span>
							) : (
								<span className="codicon codicon-stop-circle text-xs" />
							)}
						</button>
					)}
				</div>
			</div>
			{showResult && task.resultSummary && (
				<div className="mt-1 text-xs text-vscode-descriptionForeground bg-vscode-editor-background rounded p-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
					{task.resultSummary.length > 500 ? task.resultSummary.slice(0, 500) + "..." : task.resultSummary}
				</div>
			)}
		</div>
	)
}

/**
 * BackgroundTasksPanel shows active and recently completed background tasks
 * as a collapsible section in the chat sidebar. Only renders when there are
 * background tasks to display.
 *
 * Phase 6+ evolution notes:
 * - This panel can be promoted to a tab-based view alongside the main chat
 *   by extracting the task list into a shared component and rendering it in
 *   both the sidebar panel and a dedicated "Background Tasks" tab.
 * - For real-time progress streaming, each BackgroundTaskItem could accept
 *   a `progressMessages` prop with the last N tool-call summaries.
 * - For conversation replay, clicking a completed task could open its full
 *   message history in a read-only chat view (reuse ChatView with a
 *   `readOnly` flag and the task's clineMessages).
 */
const BackgroundTasksPanel: React.FC = () => {
	const { backgroundTasks } = useExtensionState()
	const [isCollapsed, setIsCollapsed] = useState(false)

	const tasks = useMemo(() => backgroundTasks ?? [], [backgroundTasks])

	const activeCount = useMemo(() => tasks.filter((t) => t.status === "running").length, [tasks])

	if (tasks.length === 0) {
		return null
	}

	return (
		<div className="border-t border-vscode-panel-border">
			<button
				className="flex items-center justify-between w-full px-3 py-1.5 bg-transparent border-none cursor-pointer hover:bg-vscode-list-hoverBackground"
				onClick={() => setIsCollapsed(!isCollapsed)}>
				<div className="flex items-center gap-1.5">
					<span
						className={`codicon ${isCollapsed ? "codicon-chevron-right" : "codicon-chevron-down"} text-xs`}
					/>
					<span className="text-xs font-medium text-vscode-foreground">Background Tasks</span>
					{activeCount > 0 && (
						<span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-medium rounded-full bg-vscode-badge-background text-vscode-badge-foreground">
							{activeCount}
						</span>
					)}
				</div>
				<span className="text-[10px] text-vscode-descriptionForeground">{tasks.length} total</span>
			</button>
			{!isCollapsed && (
				<div className="px-2 pb-1.5 max-h-[200px] overflow-y-auto">
					{tasks.map((task) => (
						<BackgroundTaskItem key={task.taskId} task={task} />
					))}
				</div>
			)}
		</div>
	)
}

export default BackgroundTasksPanel
