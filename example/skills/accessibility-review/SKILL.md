---
name: "accessibility-review"
description: "Use during accessibility review to check changed user flows for keyboard, assistive-technology and presentation barriers."
---

# Review accessibility

Apply the shared review skill and keep product code unchanged.

## Procedure

1. Identify the changed interactions and applicable accessibility requirements from
   the task and repository. Focus on the affected user journey rather than imposing a
   new whole-product compliance gate.
2. Exercise keyboard access where applicable: reach and operate changed controls, check
   focus order and visibility, and inspect focus entry, containment and return for
   dialogs or menus. Check that dismissal does not strand focus or create a trap.
3. Inspect accessible names, roles and states using the platform's available inspection
   tools. Check form labels, instructions, validation errors and status announcements.
   Use assistive technology where available; DOM or tree inspection alone is not proof
   of the actual spoken experience.
4. Inspect changed text and controls for contrast, zoom or text-scaling failures,
   clipping, color-only meaning and target accessibility against applicable requirements.
   Check image alternatives and content order where the change affects them. Cite the
   observed values and requirement for a claimed threshold failure.
5. For changed motion or dynamic updates, check reduced-motion behavior and whether
   focus or context is unexpectedly lost. Check the equivalent platform accessibility
   behavior for native UI rather than assuming browser semantics apply.

## Handoff

Record the affected control or flow, environment, input or assistive technology used,
reproduction steps, expected behavior, observed barrier and user impact. Use the shared
review procedure to distinguish blocking defects from suggestions and route findings.

Report automated results as supporting evidence, not complete accessibility approval.
Name unavailable devices, fixtures or assistive-technology checks and keep source-only
observations distinct from exercised behavior. Do not implement fixes during review.