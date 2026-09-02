# Coordination Activity

This module is the first read-only projection layer for unified orchestration. It does not own task, agent, job, Workflow, or San Loop state.

## API

- `CoordinationActivityProjector.project(sources)` maps authority snapshots to `working`, `done`, or `blocked` activity rows.
- `projectCoordinationActivities(sources)` is the stateless convenience entry point.
- `renderCoordinationActivitySummary(activities)` emits a bounded, plain-language summary for user-facing status surfaces.

Technical references remain in `technicalRefs`; the summary only exposes labels, state, progress, and next action.
