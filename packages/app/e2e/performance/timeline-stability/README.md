# Timeline stability matrix

Run from `packages/app`:

```sh
bun run test:stability
```

For diagnostic before/violation/after screenshots, set `OPENCODE_STABILITY_CAPTURE=1` before running. Screenshot capture is intentionally opt-in so compositor readback does not affect normal pass/fail timing.

The suite uses a production build, one Chromium worker, deterministic event delays, and 4x CPU throttling for adverse scenarios. Failed perceptual checks retain:

- `video.webm`
- `trace.zip`
- failure screenshot
- frame-by-frame visual trace attached to the Playwright report
- event markers and summarized violations attached to the Playwright report

The matrix intentionally remains red when a captured painted frame violates a perceptual invariant.

## Coverage

- Timeline rows: turn gaps, comments, user messages, compaction and interruption dividers, assistant parts, thinking, retry, diff summaries, and errors.
- Tool families: context tools, web fetch/search, tasks, shell, edit, write, patches, questions, skills, generic tools, and hidden todos.
- Tool states: pending, running, completed, error, dismissed question, and interrupted context member.
- Streaming: reasoning, text deltas with incomplete Markdown, empty shell output, one-line output, 50-line output, and five parallel shells completing out of order.
- Shell matrix: empty, one-line, incremental 1/10/25/50-line growth, one-burst growth, wide ANSI/CRLF output, collapsed output updates, running-to-error, and explicit expand/collapse.
- Later-content ordering: shell starts empty, a later text part arrives, then shell output streams and completes.
- User state: collapsed and expanded defaults, manual overrides, sibling updates, busy-to-idle updates, and virtualization unmount/remount.
- Adverse conditions: deterministic network jitter, bursty event delivery, 4x CPU slowdown, narrow viewport, long history, bottom anchoring, and scrolled-away visible anchors.
- File rendering: edit diffs, writes, single/multi-file patches, add/update/delete/move states, diagnostics surfaces, and diff-summary overflow.
- Structural mutations: middle-row insertion/removal, question admission, text canonical replacement, context grouping boundaries, assistant errors, and alternate idle/completion event order.
- Interaction matrix: shell/context/edit/diff-summary expansion, collapse, re-expansion, show-all/show-less surfaces, and responsive desktop-to-narrow resizing.
- Reasoning matrix: summaries on/off, absent/blank/nonblank reasoning, reasoning headings, visible sibling tools, and provider-independent payload behavior.
- Context mutation matrix: append while expanded, split/merge boundaries, first-member removal and key replacement, and collapsed-state persistence.
- Environment matrix: reduced motion, device scales 1/1.25/1.5/2, translated status labels, responsive resizing, tiny viewports, and rows taller than the viewport.
- Event race matrix: per-event analysis windows, initial stable-frame gating, stale/canonical text reconciliation, part and message removal, retry evolution, early idle, and error handoff.
- File mutation matrix: incremental patch files, diagnostics updates, nested accordion state, and outer collapse/reopen.
- Scroll interaction matrix: wheel input during remeasurement, jump-to-latest after offscreen growth, visible-anchor preservation, and virtualization state restoration.
- User parts: images, file attachments, inline file references, agent references, and synthetic comment strips.

## Perceptual invariants

- Adjacent painted rows never overlap.
- Visible rows do not disappear and return during one transition.
- Unchanged rows do not remount or duplicate.
- Status labels do not revert.
- Opacity handoffs do not produce a blank visible frame.
- Bottom-anchored content remains bottom anchored.
- Rows move monotonically for one logical update rather than up, down, then up.
- A user scrolled away from the bottom retains the same visible anchor position. Scrollbar and `scrollTop` changes alone are diagnostic and do not fail the suite.
- Manual collapse/expand intent survives unrelated and same-part updates.
