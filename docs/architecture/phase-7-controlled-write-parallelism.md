# Phase 7: Controlled Write Parallelism

> Architectural design document for Issue #12330
> Phase 7 of "Support parallel execution of specialized agents and improve context handoff between modes"

## 1. Context

Phases 1-6 incrementally built the foundation for multi-agent parallelism:

| Phase | What it delivered |
|-------|-------------------|
| 1 | Enriched context handoff summaries |
| 2 | Sequential fan-out / fan-in |
| 3a | Task isolation layer (`TaskContext`) |
| 3b | Permission control (`TaskPermissions` with file/command/tool restrictions) |
| 3c | Structured context handoff (`ContextHandoffSummary`) |
| 4 | Background read-only concurrency (`BackgroundTaskRunner`) |
| 5 | Background tasks panel UI |
| 6a | Conversation replay for background tasks |
| 6b | Tab/panel switching between tasks |
| 6c | Real-time progress streaming |

Phase 3d (Controlled Write Parallelism) was deliberately deferred during Phase 3 planning because it is the highest-risk, highest-complexity piece of the parallel execution story. Now that the read-only parallelism stack is stable, Phase 7 formalizes the deferred Phase 3d scope and extends it with supporting infrastructure.

## 2. Goals

1. **Enable write-capable background tasks** -- background tasks spawned via `new_task` with `background: true` should be able to use write tools (`write_to_file`, `apply_diff`, `execute_command`, etc.) when explicitly permitted.
2. **Prevent file conflicts** -- when multiple tasks (foreground + background, or multiple background tasks) attempt to write to the same file, the system must detect and resolve the conflict safely.
3. **Persist background task history** -- completed background task metadata and conversation history should survive VS Code restarts, enabling review and replay across sessions.

## 3. Current Architecture (Relevant Parts)

### Background Task Runner (Phase 4)

The `BackgroundTaskRunner` manages concurrent background tasks separately from the `clineStack`. Currently it enforces read-only mode:

- Background tasks are auto-approved for all tool uses
- Write tools are denied via `TaskPermissions.deniedTools`
- No file contention is possible because no background task can write

### Permission System (Phase 3b)

`TaskPermissions` supports:
- `filePatterns` -- regex patterns restricting which files can be read/written
- `commandPatterns` -- regex patterns restricting which commands can be executed
- `allowedTools` / `deniedTools` -- tool-level allow/deny lists
- Layered merging with most-restrictive-wins semantics

The permission system already supports fine-grained file restrictions; it just needs to be extended with conflict-awareness for concurrent writes.

### Task Context (Phase 3a)

`TaskContext` (built by `TaskContextBuilder`) snapshots mode, API config, and permissions for each task independently. Background tasks already carry isolated contexts.

## 4. Proposed Scope

Phase 7 is organized into three sub-phases, each independently shippable:

### Phase 7a: File Lock Manager

**Objective**: Introduce a file-level locking mechanism that background tasks must acquire before writing.

**Key components**:

```typescript
/**
 * Advisory file lock manager for coordinating writes across concurrent tasks.
 *
 * Locks are "advisory" -- they do not use OS-level file locks. Instead, the
 * tool execution layer checks the lock manager before allowing write operations.
 * This keeps the system portable and testable.
 */
interface FileLockManager {
  /**
   * Attempt to acquire a write lock on a file for a specific task.
   * Returns true if the lock was acquired, false if another task holds it.
   */
  acquireLock(filePath: string, taskId: string): boolean

  /**
   * Release a lock held by a specific task.
   * No-op if the task does not hold the lock.
   */
  releaseLock(filePath: string, taskId: string): void

  /**
   * Release all locks held by a specific task.
   * Called when a task completes, is cancelled, or errors out.
   */
  releaseAllLocks(taskId: string): void

  /**
   * Check which task (if any) holds the lock on a file.
   * Returns the taskId of the lock holder, or undefined if unlocked.
   */
  getLockHolder(filePath: string): string | undefined

  /**
   * List all files currently locked by a specific task.
   */
  getLockedFiles(taskId: string): string[]
}
```

**Lock semantics**:
- Locks are per-file, not per-directory
- A task must hold the lock before any write tool (`write_to_file`, `apply_diff`) executes on that file
- `execute_command` does not acquire file locks (commands have unpredictable file effects; this is handled by the conflict detection layer in Phase 7b)
- Locks are automatically released when a task completes, is cancelled, or times out
- The foreground task implicitly holds locks on files it is actively editing (claimed at write-tool execution time, same as background tasks)

**Integration points**:
- The tool execution layer (where `TaskPermissions` enforcement currently happens) checks the `FileLockManager` before executing write tools
- If a lock is held by another task, the write tool returns an error message to the LLM explaining which task holds the lock and suggesting the task work on a different file or wait
- `BackgroundTaskRunner.cleanup()` calls `releaseAllLocks(taskId)` on task completion

### Phase 7b: Write-Capable Background Tasks

**Objective**: Remove the read-only restriction from background tasks, gated behind explicit permission.

**Key changes**:

1. **New `new_task` parameter**: `allowWrites: true` (defaults to `false`)
   - When `background: true` and `allowWrites: true`, the background task is permitted to use write tools
   - When `background: true` and `allowWrites: false` (default), current read-only behavior is preserved
   - `allowWrites: true` without `background: true` has no effect (foreground tasks already have write access)

2. **Permission enforcement changes**:
   - Background tasks with `allowWrites: true` still respect `filePatterns` from `TaskPermissions` -- they can only write to files matching their permitted patterns
   - The `FileLockManager` from 7a provides the concurrency guard
   - The combination of `filePatterns` + `FileLockManager` gives two layers of write safety: pattern-based scope restriction AND lock-based concurrency control

3. **Approval flow**:
   - Spawning a write-capable background task requires explicit user approval (the approval dialog should clearly indicate this task can modify files)
   - Individual file writes within a background task are auto-approved (consistent with current background task behavior) but the initial spawn requires approval

4. **Conflict detection**:
   - When a write-capable background task attempts to write a file that is locked by another task, the tool returns an error to the LLM
   - The error includes the conflicting task's ID and mode, enabling the LLM to adapt (e.g., pick a different file, wait, or report the conflict)
   - The Orchestrator's system prompt is updated with guidance on handling write conflicts between parallel subtasks

**Orchestrator prompt additions**:

```
When spawning write-capable background tasks:
- Use filePatterns to restrict each task to non-overlapping file sets when possible
- If two tasks need to modify the same file, run them sequentially instead of in parallel
- Monitor structured context handoff summaries to detect overlapping file modifications
- If a background task reports a lock conflict, consider re-queuing that work after the lock holder completes
```

### Phase 7c: Persistent Background Task History

**Objective**: Background task metadata and conversation history persist across VS Code sessions.

**Current gap**: Background tasks are tracked in-memory by `BackgroundTaskRunner`. When VS Code restarts, all background task state is lost. Completed background tasks are only visible in the current session.

**Key changes**:

1. **Persist background task metadata in `TaskHistoryStore`**:
   - Background tasks already create `HistoryItem` entries (via the task lifecycle)
   - Add a `background: true` flag to `HistoryItem` so the UI can distinguish background tasks from foreground tasks
   - Add `parentTaskId` linkage so background tasks appear as children of their spawning task in the history view

2. **Persist background task messages**:
   - Background tasks already write messages to disk via `saveTaskMessages()` (this happens during task execution)
   - Ensure the replay view (Phase 6a) works for background tasks loaded from persisted history, not just from the in-memory `BackgroundTaskRunner` state

3. **History UI updates**:
   - The History view shows background tasks with a distinct visual indicator (e.g., a background task icon or label)
   - Background tasks are filterable in the history view (show/hide background tasks)
   - Clicking a background task in history opens the replay view (Phase 6a)

4. **Cleanup policy**:
   - Background task history follows the same retention policy as foreground tasks
   - No separate cleanup logic needed

## 5. Architectural Risks and Mitigations

### Risk 1: Lock contention causing task starvation (HIGH)

If a foreground task holds a lock on a frequently-edited file for a long time, background tasks that need that file will repeatedly fail and waste API tokens retrying.

**Mitigation**:
- Locks have a configurable maximum hold duration (default: 2 minutes). After the timeout, the lock is forcibly released and the holding task is notified.
- The LLM receives clear error messages on lock failure, including guidance to work on other files first.
- The Orchestrator prompt encourages non-overlapping file assignments.

### Risk 2: `execute_command` bypassing file locks (MEDIUM)

Shell commands can write to any file without going through the file lock system. A background task running `echo "foo" > bar.ts` bypasses all lock checks.

**Mitigation**:
- Write-capable background tasks should have `commandPatterns` set to restrict which commands they can run
- The Orchestrator prompt advises against giving background tasks broad command access when file safety is needed
- A future enhancement could parse common command patterns (e.g., redirect operators) for additional safety, but this is out of scope for Phase 7

### Risk 3: Merge conflicts from concurrent writes to different parts of the same file (MEDIUM)

Two tasks might legitimately need to modify different sections of the same file. File-level locking prevents this, forcing serialization.

**Mitigation**:
- File-level (not line-level) locking is the right starting point. Line-level locking adds significant complexity for limited benefit.
- The Orchestrator should be guided to split work at the file boundary when possible (e.g., "task A handles `api.ts`, task B handles `utils.ts`")
- A future enhancement could support a "lock-and-queue" model where the second task's write is queued until the first task releases the lock, rather than failing immediately

### Risk 4: Background task history bloating storage (LOW)

Persistent background task history could accumulate rapidly if background tasks are used frequently.

**Mitigation**:
- Reuse existing history retention policies (same max items, same cleanup)
- Background tasks share the same storage pool as foreground tasks
- No additional cleanup logic needed for Phase 7

## 6. Dependency Chain

```
Phase 7a: File Lock Manager              (foundation)
    |
    v
Phase 7b: Write-Capable Background Tasks (depends on 7a)
    |
    v
Phase 7c: Persistent Background History  (independent of 7a/7b, can be parallel)
```

Phase 7c has no dependency on 7a or 7b -- it can be implemented in parallel with 7a/7b or after them, whichever is more convenient.

## 7. Testing Strategy

| Area | Test Type | Key Scenarios |
|------|-----------|---------------|
| FileLockManager | Unit (vitest) | Acquire/release, contention between tasks, timeout expiry, cleanup on task completion |
| Write permission enforcement | Unit (vitest) | Background task with `allowWrites: true/false`, lock check before write, conflict error messages |
| Orchestrator prompt | Integration | Verify prompt includes write-conflict guidance when write-capable background tasks are enabled |
| History persistence | Unit (vitest) | Background task metadata saved/loaded across sessions, replay view loads persisted messages |
| Lock + permission interaction | Unit (vitest) | `filePatterns` restriction combined with lock check, layered permission merging with write-capable children |

## 8. Open Questions

1. **Lock granularity**: Should we support directory-level locks (e.g., lock `src/components/` so a task has exclusive access to that subtree)? This would reduce lock management overhead but increase contention scope. Recommendation: start with file-level only, add directory locks if users need them.

2. **Lock queuing vs. fail-fast**: When a lock is held, should the requesting task fail immediately (current proposal) or queue and wait? Recommendation: fail-fast for Phase 7, with the error message suggesting the task work on other files. Queuing adds complexity with unclear benefit since the LLM can adapt.

3. **Command audit**: Should write-capable background tasks log all commands they execute for post-hoc review? This would help users understand what a background task did, especially for commands that bypass file locks. Recommendation: defer to a follow-up; the structured context handoff (Phase 3c) already captures executed commands.

## 9. Updated Roadmap

| Phase | Description | PR(s) | Status |
|-------|------------|-------|--------|
| 1 | Enriched context handoff summaries | #12332 | Open |
| 2 | Sequential fan-out / fan-in | #12348 (combined) | Open |
| 3a | Task Isolation Layer | #12348 (combined) | Open |
| 3b | Permission control for subtasks | #12348 (combined) | Open |
| 3c | Structured context handoff | #12348 (combined) | Open |
| 4 | Background read-only concurrency | #12349 (combined) | Open |
| 5 | Background tasks panel UI | #12349 (combined) | Open |
| 6a | Conversation replay | #12349 (combined) | Open |
| 6b | Tab/panel switching | #12349 (combined) | Open |
| 6c | Real-time progress streaming | #12349 (combined) | Open |
| **7a** | **File Lock Manager** | -- | **Not started** |
| **7b** | **Write-capable background tasks** | -- | **Not started** |
| **7c** | **Persistent background task history** | -- | **Not started** |

### Branch Stack

```
main
  +-- feature/enhanced-subtask-handoff-summary (Phase 1 - PR #12332)
        +-- feature/phase-2-3-combined (Phase 2+3 - PR #12348)
              +-- feature/remaining-phases-4-5-6 (Phase 4+5+6 - PR #12349)
                    +-- feature/phase-7-write-parallelism (Phase 7 - this branch)
```
