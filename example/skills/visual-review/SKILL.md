---
name: "visual-review"
description: "Use during visual review to inspect changed UI layouts, responsive behavior and interaction states against the agreed design."
---

# Review visual behavior

Apply the shared review skill and keep product code unchanged.

## Procedure

1. Identify the changed screens or components and the visual acceptance criteria in
   plan and userDecisions. Use supplied designs and nearby existing screens as the
   baseline; do not introduce a redesign based on personal taste.
2. Render the relevant current revision with available, authorized tools and fixtures.
   Capture and inspect screenshots at the affected desktop and mobile sizes, or the
   applicable native device sizes. Record which revision, viewport and state they show.
3. Check alignment, balanced padding, text wrapping, clipping, overlap and scroll reach.
   Compare typography, color, imagery and component treatment with the agreed baseline.
   Ensure primary content and controls remain visible and usable in the changed flow.
4. Exercise relevant interaction states, such as focus, hover, pressed, disabled and
   open overlays. Inspect loading, empty, error or long-content states where the change
   affects them. Look for layout jumps and lost feedback, not only a static happy path.
5. For changed motion, inspect the transition and its interrupted or reduced-motion
   behavior where applicable. Do not require animations or visual effects the task did
   not request. Keep the assessment proportional to the affected UI.

## Handoff

Record visual defects through the shared review procedure with the screen or component,
viewport, state, expected baseline and observed difference. Link the relevant screenshot
or other evidence and describe the smallest correction that restores the intended result.

If rendering, fixtures or reference designs are unavailable, distinguish source-only
observations from verified visual findings. State exactly what was not inspected; do not
claim visual approval from code inspection alone or edit the UI during review.