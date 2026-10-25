// Compose actual, synchronized browser captures. This does not synthesize UI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const usage = "Usage: node scripts/testing/compose-team-video.mjs FRAME_DIRECTORY OUTPUT.mp4 [POSTER.jpg]\nSet FFMPEG_BINARY and optionally OMB_VIDEO_FONT when their defaults are unavailable.";
const exec = promisify(execFile);
const people = ["alice", "bob", "chris"];
const slash = path => path.replaceAll("\\", "/");
const quotedFile = path => `'${slash(path).replaceAll("'", "'\\''")}'`;

async function compose() {
  assert.ok(process.argv.length === 4 || process.argv.length === 5, usage);
  const input = resolve(process.argv[2]), output = resolve(process.argv[3]);
  const poster = process.argv[4] ? resolve(process.argv[4]) : undefined;
  assert.ok(output.endsWith(".mp4"), "Output must be an MP4 file.");
  assert.ok(!poster || /\.jpe?g$/i.test(poster), "Poster must be a JPEG file.");
  const timeline = JSON.parse(readFileSync(join(input, "timeline.json"), "utf8"));
  const { frames, phases = [], width = 640, height = 900 } = timeline;
  assert.ok(Array.isArray(frames) && frames.length, "timeline.frames must contain recorded frames.");
  assert.ok(Number.isInteger(width) && width > 0 && width % 2 === 0 && Number.isInteger(height) && height > 0 && height % 2 === 0, "Frame dimensions must be positive even integers.");
  for (const [index, frame] of frames.entries()) {
    assert.ok(Number.isFinite(frame.timeMs) && frame.timeMs >= 0 && (!index || frame.timeMs > frames[index - 1].timeMs), "Frame times must increase strictly.");
  }
  assert.ok(Array.isArray(phases), "timeline.phases must be an array.");
  for (const [index, phase] of phases.entries()) {
    assert.ok(Number.isFinite(phase.timeMs) && phase.timeMs >= 0 && (!index || phase.timeMs > phases[index - 1].timeMs), "Phase times must increase strictly.");
    assert.equal(typeof phase.title, "string");
    assert.equal(typeof phase.detail, "string");
    assert.ok(!/[\r\n]/.test(phase.title + phase.detail), "Each caption must fit one line; use concise phase text.");
  }
  const origin = frames[0].timeMs;
  const finalInterval = frames.length > 1 ? frames.at(-1).timeMs - frames.at(-2).timeMs : 500;
  const end = timeline.durationMs ?? frames.at(-1).timeMs + finalInterval;
  assert.ok(Number.isFinite(end) && end > frames.at(-1).timeMs, "durationMs must be later than the last frame.");
  const duration = (end - origin) / 1000;
  const ffmpeg = resolve(process.env.FFMPEG_BINARY ?? ".omb-scratch/verify-tools/package/ffmpeg.exe");
  assert.ok(existsSync(ffmpeg), "Set FFMPEG_BINARY to an installed ffmpeg executable.");
  const font = process.env.OMB_VIDEO_FONT ?? [
    "C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc",
  ].find(existsSync);
  assert.ok(font && existsSync(font), "Set OMB_VIDEO_FONT to a readable TrueType/OpenType font.");
  const temporary = mkdtempSync(join(input, ".compose-"));
  copyFileSync(font, join(temporary, "font.ttf"));
  const inputs = [];
  for (const person of people) {
    const lines = ["ffconcat version 1.0"];
    for (const [index, frame] of frames.entries()) {
      const file = join(input, person, `frame-${String(index).padStart(6, "0")}.jpg`);
      assert.ok(existsSync(file), `Missing captured frame: ${file}`);
      const next = frames[index + 1]?.timeMs ?? end;
      lines.push(`file ${quotedFile(file)}`, `duration ${((next - frame.timeMs) / 1000).toFixed(6)}`);
    }
    lines.push(`file ${quotedFile(join(input, person, `frame-${String(frames.length - 1).padStart(6, "0")}.jpg`))}`);
    const list = join(temporary, `${person}.ffconcat`);
    writeFileSync(list, lines.join("\n") + "\n");
    inputs.push("-f", "concat", "-safe", "0", "-i", list);
  }
  const videoWidth = width * 3, videoHeight = height + 180;
  const filters = [];
  const text = (file, content, options) => {
    writeFileSync(join(temporary, file), content, "utf8");
    filters.push(`drawtext=fontfile=font.ttf:textfile=${file}:expansion=none:${options}`);
  };
  for (const [index, label] of ["ALICE / requester", "BOB / provider owner", "CHRIS / group member"].entries()) {
    text(`heading-${index}.txt`, label, `fontcolor=white:fontsize=28:x=${width * index}+(${width}-text_w)/2:y=17`);
  }
  text("footer.txt", "Live OpenCode / MiMo | isolated CLI profiles | Tailscale transport simulated", `fontcolor=0xa9bdca:fontsize=18:x=32:y=${videoHeight - 28}`);
  for (const [index, phase] of phases.entries()) {
    const start = Math.max(0, (phase.timeMs - origin) / 1000);
    const stop = Math.min(duration, ((phases[index + 1]?.timeMs ?? end) - origin) / 1000);
    if (stop <= start) continue;
    const enable = `enable='gte(t,${start.toFixed(6)})*lt(t,${stop.toFixed(6)})'`;
    const titleSize = Math.min(28, Math.floor((videoWidth - 64) / Math.max(1, phase.title.length * 0.6)));
    const detailSize = Math.min(22, Math.floor((videoWidth - 64) / Math.max(1, phase.detail.length * 0.6)));
    assert.ok(titleSize >= 18 && detailSize >= 16, "A phase caption is too long to remain readable; shorten it.");
    text(`title-${index}.txt`, phase.title, `fontcolor=white:fontsize=${titleSize}:x=32:y=${videoHeight - 103}:${enable}`);
    text(`detail-${index}.txt`, phase.detail, `fontcolor=0xd4e0e7:fontsize=${detailSize}:x=32:y=${videoHeight - 65}:${enable}`);
  }
  const graph = `[0:v][1:v][2:v]hstack=inputs=3:shortest=1,pad=iw:ih+180:0:70:color=0x142936,${filters.join(",")},fps=12,format=yuv420p[out]`;
  writeFileSync(join(temporary, "filters.txt"), graph);
  mkdirSync(dirname(output), { recursive: true });
  const options = { cwd: temporary, windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 };
  await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex_threads", "1", "-filter_complex_script", "filters.txt", "-map", "[out]", "-an", "-t", duration.toFixed(6), "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-threads", "2", "-movflags", "+faststart", output], options);
  if (poster) {
    mkdirSync(dirname(poster), { recursive: true });
    const at = Math.max(0, Math.min(duration - 0.1, ((timeline.posterTimeMs ?? end - 2000) - origin) / 1000));
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(3), "-i", output, "-frames:v", "1", "-q:v", "2", poster], options);
  }
  console.log(JSON.stringify({ video: output, poster, frames: frames.length, durationSeconds: duration, width: videoWidth, height: videoHeight, fps: 12, timing: "recorded wall time preserved", compositionFiles: temporary }));
}

if (process.argv.includes("--help")) console.log(usage);
else await compose().catch(error => {
  console.error(String(error.message).slice(0, 4000));
  process.exitCode = 1;
});
