import { mkdir, writeFile } from 'node:fs/promises';
// Red on the source's left, blue on its right. Inspect received pixels to test
// transmitted mirroring, rather than trusting CSS or the local preview.
const width = 640, height = 480;
const y = Buffer.alloc(width * height), u = Buffer.alloc(width * height / 4), v = Buffer.alloc(width * height / 4);
for (let row = 0; row < height; row++) for (let x = 0; x < width; x++) y[row * width + x] = x < width / 2 ? 81 : 41;
for (let row = 0; row < height / 2; row++) for (let x = 0; x < width / 2; x++) { u[row * width / 2 + x] = x < width / 4 ? 90 : 240; v[row * width / 2 + x] = x < width / 4 ? 240 : 110; }
const frames = [Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`)];
for (let i = 0; i < 30; i++) frames.push(Buffer.from('FRAME\n'), y, u, v);
await mkdir('tests/fixtures', { recursive: true });
await writeFile('tests/fixtures/two-colors.y4m', Buffer.concat(frames));
