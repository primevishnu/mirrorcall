# Camera Flip 1.0.1

- Fix preview flickering: draw into an off-screen buffer, then present once.
- Prevent parent background painting over the preview.
- Smoother preview, up to 30 fps, with a single pending notification and bounded buffers.
- Isolate camera callbacks and flush events between sessions; safely drain active work.
- Try alternate camera formats/conversions when a preferred mode fails.
- Detect a busy virtual-camera output before opening the physical camera.
- Validate buffer offsets and signed strides, and handle initialization/worker failures.
- Add preview rendering/resource, restart, stale-callback and isolated GUI checks.
- Produce a versioned executable with Windows version metadata, alongside the generic
  filename when it can be replaced safely. Includes the complete source and OBS license.

Calling apps must still select and accept OBS Virtual Camera. This update does not
provide a universal override for every application's camera settings or policies.
