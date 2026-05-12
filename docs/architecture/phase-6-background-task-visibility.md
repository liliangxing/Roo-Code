# Phase 6: Background Task Visibility and Interaction

> Architectural design document for Issue #12330  
> Phase 6 of "Support parallel execution of specialized agents and improve context handoff between modes"

## 1. Context

Phase 5 (Background Tasks Panel UI) is complete. This document proposes the scope, priority, and architecture for Phase 6, which focuses on enabling better visibility and interaction with background tasks.

## 2. Current Architecture

### Task Lifecycle

`ClineProvider` maintains a `clineStack: Task[]` (LIFO). Only the top-of-stack task is "current" -- all state updates, webview messages, and user interactions route through `getCurrentTask()`.

```
ClineProvider
├── clineStack: Task[]          # LIFO stack, sequential execution
├── taskHistoryStore             # Per-task file persistence
├── getCurrentTask()             # Returns top of stack
├── addClineToStack(task)        # Push new task
└── removeClineFromStack()       # Pop completed task
```

### Task Persistence

| Layer | File | Purpose |
|-------|------|---------|
| Messages | `taskMessages.ts` | Save/load `ClineMessage[]` per task |
| API History | `apiMessages.ts` | Save/load API conversation history |
| History Items | `TaskHistoryStore.ts` | Per-task metadata files with in-memory cache |
| Metadata | `taskMetadata.ts` | Task metadata helpers |

### Webview Communication

The extension sends typed `ExtensionMessage` objects to the webview. Key message types:

- `state` -- Full state snapshot (includes `clineMessages`, `currentTaskId`)
- `taskHistoryUpdated` -- Full history list refresh
- `taskHistoryItemUpdated` -- Single history item update

Currently, `postStateToWebviewWithoutTaskHistory()` sends state for only the current task. There is no mechanism to send updates for background tasks.

### Subtask Support

Parent-child relationships exist via `parentTaskId` and `childIds` on `HistoryItem`. The `new_task` tool creates subtasks that push onto the stack. When a subtask completes, it pops and returns control to the parent.

## 3. Agreed Scope for Phase 6

**In scope (Items 1-3):**
1. Full conversation replay for completed background tasks
2. Tab switching / multi-task view
3. Real-time progress streaming for active background tasks

**Deferred to Phase 7 (Items 4-5):**
4. Write-capable background tasks + basic file locking
5. Persistent background task history across sessions

## 4. Feasibility Analysis

### Item 1: Full Conversation Replay

**Complexity: Medium | Risk: Low**

`readTaskMessages(taskId, globalStoragePath)` already loads the full `ClineMessage[]` array from disk for any task. The existing `ChatView` component renders these messages. The main work is creating a read-only wrapper that:

- Accepts a `taskId` prop instead of reading from global state
- Loads messages on mount via a new webview message
- Hides input controls (chat box, approval buttons)
- Renders tool calls, outputs, and assistant responses in the same format

**Why it's low risk:** No changes to task execution, persistence, or the foreground task flow. Purely additive UI + a new message handler.

### Item 2: Tab Switching / Multi-task View

**Complexity: Medium-High | Risk: Medium**

The webview already has a tab system in `App.tsx` (`tab === "history"`, `tab === "settings"`, `tab === "chat"`). Adding a background tasks view requires:

- A new tab or panel within the chat view
- A list of active/completed background tasks with status indicators
- Navigation to open a task's replay view or live view
- State management to track which background task is currently being viewed

**Key challenge:** The webview currently receives state for only one task. Viewing a background task must not disrupt the foreground task's state. This requires either:
  - (a) A separate message channel for background task data, or
  - (b) A secondary state context in the webview that can hold background task data alongside the primary task state

Option (a) is cleaner and avoids polluting the existing state management.

### Item 3: Real-time Progress Streaming

**Complexity: High | Risk: Medium-High**

Currently, `Task.ts` calls `provider.postStateToWebviewWithoutTaskHistory()` to update the UI. This method sends the full state for the current task only. For background tasks to stream progress:

1. `Task.ts` must emit incremental updates even when it is not the "current" task
2. A new message type (`backgroundTaskProgress`) must carry task-scoped updates
3. The webview must handle concurrent update streams without degrading performance
4. Throttling/batching is needed to prevent excessive re-renders

**Why it's harder:** Requires changes to the core task execution loop (`Task.ts`), not just additive UI. The task currently assumes it IS the visible task when posting updates.

## 5. Recommended Priority Order

```
Phase 6a: Conversation Replay         (Foundation -- standalone value)
    │
    ▼
Phase 6b: Tab/Panel Switching          (Navigation framework, depends on 6a)
    │
    ▼
Phase 6c: Real-time Progress Streaming (Highest complexity, builds on 6b)
```

Each sub-phase is independently shippable and testable.

## 6. Detailed Design

### 6a. Conversation Replay

#### New Message Types

```typescript
// Webview → Extension
interface RequestBackgroundTaskMessages {
  type: "requestBackgroundTaskMessages"
  taskId: string
}

// Extension → Webview
interface BackgroundTaskMessages {
  type: "backgroundTaskMessages"
  taskId: string
  messages: ClineMessage[]
}
```

#### Extension Handler (webviewMessageHandler.ts)

```typescript
case "requestBackgroundTaskMessages": {
  const taskId = message.taskId
  const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
  const messages = await readTaskMessages(taskId, globalStoragePath)
  provider.postMessageToWebview({
    type: "backgroundTaskMessages",
    taskId,
    messages: messages ?? [],
  })
  break
}
```

#### Webview Component

```
BackgroundTaskReplayView
├── Props: { taskId: string, onClose: () => void }
├── State: messages (ClineMessage[]), loading (boolean)
├── On mount: sends requestBackgroundTaskMessages
├── On message: receives backgroundTaskMessages, filters by taskId
├── Renders: read-only message list (reuses ChatRow components)
└── No input controls, no approval buttons
```

### 6b. Tab/Panel Switching

#### UI Structure

```
App.tsx
├── tab === "chat"     → ChatView (foreground task)
├── tab === "history"  → HistoryView
├── tab === "settings" → SettingsView
└── tab === "bgTask"   → BackgroundTaskView
    ├── BackgroundTasksList (sidebar/panel)
    │   ├── Active tasks with status badges
    │   └── Completed tasks
    └── BackgroundTaskReplayView (from 6a) OR BackgroundTaskLiveView (from 6c)
```

#### State Management

```typescript
// New webview state (in App.tsx or dedicated context)
interface BackgroundTaskViewState {
  selectedTaskId: string | null
  viewMode: "replay" | "live"
}
```

#### Navigation Flow

1. User clicks background task icon/tab
2. App switches to `tab === "bgTask"`
3. BackgroundTasksList shows available tasks
4. User clicks a task → sets `selectedTaskId`
5. If task is completed → opens BackgroundTaskReplayView
6. If task is active → opens BackgroundTaskLiveView (Phase 6c)

### 6c. Real-time Progress Streaming

#### New Message Types

```typescript
// Extension → Webview (incremental updates)
interface BackgroundTaskProgress {
  type: "backgroundTaskProgress"
  taskId: string
  update: BackgroundTaskUpdate
}

interface BackgroundTaskUpdate {
  kind: "tool_call" | "tool_result" | "assistant_text" | "status_change" | "error"
  timestamp: number
  data: any  // Typed per kind
}
```

#### Task.ts Changes

Add a method that emits progress regardless of whether the task is "current":

```typescript
// In Task.ts
private emitBackgroundProgress(update: BackgroundTaskUpdate) {
  const provider = this.providerRef.deref()
  if (!provider) return
  
  // Only emit background updates when this task is NOT the current task
  if (provider.getCurrentTask()?.taskId === this.taskId) return
  
  provider.postMessageToWebview({
    type: "backgroundTaskProgress",
    taskId: this.taskId,
    update,
  })
}
```

#### Throttling Strategy

- Batch updates in 200ms windows
- Cap at 10 updates per batch per task
- Drop older updates if buffer exceeds threshold
- Priority: status_change > error > tool_result > tool_call > assistant_text

#### Webview: BackgroundTaskLiveView

```
BackgroundTaskLiveView
├── Props: { taskId: string }
├── State: updates (BackgroundTaskUpdate[]), status
├── Subscribes to backgroundTaskProgress messages filtered by taskId
├── Renders: streaming list of tool calls and results
├── Auto-scrolls to latest update
└── Shows task status badge (running, paused, completed, errored)
```

## 7. Testing Strategy

| Area | Test Type | Key Scenarios |
|------|-----------|---------------|
| Message handler | Unit (vitest) | Request/response for task messages, missing task, corrupt data |
| BackgroundTaskReplayView | Component (vitest + RTL) | Loading state, message rendering, empty state |
| Tab switching | Component (vitest + RTL) | Tab navigation, state preservation, back to foreground |
| Progress streaming | Unit (vitest) | Throttling, batching, concurrent tasks |
| Integration | E2E (if feasible) | Full flow: start bg task → view progress → replay after completion |

## 8. Open Questions

1. **Should the background task list be a sidebar panel or a tab?** A sidebar panel (like the existing Phase 5 panel) keeps the foreground task visible. A tab replaces the view entirely but is simpler.

2. **Message size limits for replay:** Completed tasks can have thousands of messages. Should we paginate or lazy-load? Initial recommendation: load all at once (same as current ChatView behavior), optimize if performance becomes an issue.

3. **Progress streaming granularity:** Should we stream every tool call parameter, or just tool names + status? Start with names + status, add detail incrementally.
