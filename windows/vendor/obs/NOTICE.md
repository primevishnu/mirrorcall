# OBS virtual-camera transport

These four source files are copied from OBS Studio **32.0.1**, at
https://github.com/obsproject/obs-studio/tree/32.0.1/plugins/win-dshow

- `shared-memory-queue.c` / `.h`
- `tiny-nv12-scale.c` / `.h`

They implement OBS's existing Windows virtual-camera shared-memory protocol.
Copyright belongs to the OBS Project contributors. The upstream GPL version 2
license is reproduced in `COPYING`. This Windows application is distributed under
GPL-2.0-or-later; its complete source and build instructions accompany the executable.

Local changes are marked `Camera Flip` in the source: reject a concurrently-created
publisher mapping rather than overwrite it, and release mapped views if allocation fails.
No OBS DLL, installer, executable, or camera driver is bundled or re-registered.
