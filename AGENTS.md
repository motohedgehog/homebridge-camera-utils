# Agent guide

## Project and code map

`@homebridge/camera-utils` is a single-package TypeScript library for Homebridge camera plugins. It provides FFmpeg process helpers, UDP port selection, RTP/RTCP packet routing, SRTP key helpers, and HomeKit return-audio transcoding. It has no application server or database.

- `src/index.ts` is the public entry point. Add public exports here and preserve compatibility for consuming plugins.
- `src/ffmpeg.ts` selects the `ffmpeg-for-homebridge` binary, falling back to `ffmpeg` on PATH, and probes installation/codec support.
- `src/ffmpeg-process.ts` wraps process spawning, callbacks, logging, stdin, and shutdown. Constructing `FfmpegProcess` immediately spawns FFmpeg.
- `src/ports.ts` selects consecutive ports and binds UDP sockets.
- `src/rtp.ts` reads packet payload types and SSRC identifiers; `src/rtp-splitter.ts` routes packets using a UDP socket and RxJS observables.
- `src/srtp.ts` generates and encodes SRTP keys and salts and builds SDP crypto lines.
- `src/return-audio-transcoder.ts` combines the process, port, packet, and SRTP helpers for HomeKit return audio.
- `src/default-ip.ts` retains network-address discovery for older consumers.
- Tests live separately in `test/*.spec.ts`; generated API documentation lives in `docs/`.

When `.codegraph/` exists, use CodeGraph before searching or reading indexed source. Pass this repository's path when querying from another workspace. Fall back to direct reads for files or details absent from the graph; use ordinary search for configuration and documentation.

## Setup and development

Run commands from the repository root. Use npm and keep `package-lock.json` consistent with dependency changes. `package.json` currently declares no Node engine range; consult the shared CI workflow when changing runtime compatibility rather than borrowing another Homebridge repository's requirements.

| Task                          | Command                                      | Notes                                                                                                                                |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Install                       | `npm ci`                                     | Requires registry access; FFmpeg installation may also need a binary download.                                                       |
| Build                         | `npm run build`                              | Cleans `dist/` and `coverage/`, then compiles source and declarations into `dist/`.                                                  |
| Watch with a consuming plugin | `npm run watch:link`                         | Runs `npm link` and TypeScript watch with declarations; changes the global npm link. Link this package from the consumer separately. |
| Tests, once                   | `npm test -- --run`                          | Suitable for unattended checks.                                                                                                      |
| Tests, watch                  | `npm test`                                   | Vitest's interactive watch workflow.                                                                                                 |
| Focus one file                | `npm test -- --run test/srtp.spec.ts`        | Substitute another test path as needed.                                                                                              |
| Focus by name                 | `npm test -- --run -t 'generateSrtpOptions'` | Filters test names.                                                                                                                  |
| Coverage                      | `npm run test-coverage`                      | V8 coverage scoped to `src/**`; no threshold is configured.                                                                          |
| Lint and fix                  | `npm run lint`                               | Includes `--fix`; inspect the resulting diff.                                                                                        |
| Lint without edits            | `npm exec -- eslint '**/*.ts'`               | Uses the same TypeScript file pattern without autofixing.                                                                            |
| Check API docs                | `npm run lint-docs`                          | TypeDoc warnings are errors; emits no documentation.                                                                                 |
| Generate API docs             | `npm run docs`                               | Writes to the tracked `docs/` directory.                                                                                             |

`npm run check` installs dependencies and reports outdated packages; it is not the test or type-check command. Use the build to check source types. The TypeScript build excludes tests.

## Verification

For source changes, run the build, one-shot tests, and lint. Run `npm run lint-docs` when changing exports, public types, or API comments. Run coverage after the build if you need its output, because the build deletes `coverage/`.

Vitest uses the threads pool and a 10-second test timeout. Existing tests cover FFmpeg probes, consecutive UDP port selection, and SRTP encoding/decoding and key lengths. Tests import the public barrel in `src/index.ts`; preserve that pattern when testing exported behavior.

The FFmpeg tests execute a real binary and expect Opus support. Port tests bind real UDP sockets. Diagnose missing binaries, unavailable codecs, socket permissions, and port conflicts before changing assertions. Existing tests do not cover complete camera streams or the process/splitter/transcoder lifecycle; test affected cleanup and routing behavior explicitly when modifying those paths, and report any hardware validation still needed.

Baseline when this guide was created: build, all 11 tests, and the API documentation check passed. Lint reported six `unused-imports/no-unused-vars` errors on function-type parameter names in `src/ffmpeg-process.ts` and `src/rtp-splitter.ts`. Recheck this baseline when touching those files; distinguish existing failures from new ones.

## Style and compatibility

- Use strict TypeScript and ESM. Relative imports use `.js` suffixes in `.ts` files; built consumers load `dist/index.js`.
- Match the existing two-space indentation, LF endings, single quotes, and omitted semicolons. Use `import type` for type-only dependencies and `node:` for Node built-ins.
- Follow `eslint.config.js` for import/export sorting and other rules. Review autofixes rather than introducing another formatting tool.
- Keep source edits in `src/`; `dist/` is generated and ignored. Regenerate `docs/` with TypeDoc when documentation output is part of the task.
- Treat exported helpers and option shapes as plugin-facing API. Check `src/index.ts`, callers, tests, declarations from the build, and documentation for affected changes.

## Streaming invariants and sensitive data

- Preserve consecutive RTP/RTCP port allocation: FFmpeg uses the next port for RTCP. The current selector uses a 15-second reservation timeout for HomeKit stream setup; preserve that timing unless deliberately changing setup behavior.
- Preserve idempotent shutdown of FFmpeg processes and splitters. Close sockets, unsubscribe observables, and terminate child processes on stop/error paths so streams do not leak resources or keep the consumer alive.
- `ReturnAudioTranscoder.start()` returns the splitter port for HomeKit's `audio.port`. Incoming-stream RTCP is routed by SSRC separately from return-audio RTP/RTCP; keep these routes distinct.
- Return audio handles Opus and AAC-ELD with different FFmpeg decoder arguments and SDP. Keep codec selection, payload type, sample rate, channels, and SDP consistent.
- SRTP currently uses 16-byte keys and 14-byte salts with `AES_CM_128_HMAC_SHA1_80`. Keep cryptographic randomness and wire-format compatibility. Treat keys, salts, camera credentials, and SDP crypto lines as secrets when adding logs or fixtures.

## CI and publishing

Read `.github/workflows/` for triggers and shared workflow references. Pull requests and pushes to `latest` run the shared build/test workflow with coverage, followed by lint. Beta branches (`beta` and `beta-*.*.*`) also publish beta packages after those checks. Published GitHub releases trigger the stable publishing workflow. Shared workflow implementations live in `homebridge/.github` and can change independently of this checkout.

The npm package includes `dist/`. `prepublishOnly` updates the lockfile, runs lint with fixes, and builds; `postpublish` removes build and coverage output. These hooks mutate the checkout. Leave release/version changes and publishing to an explicitly requested release task; ordinary verification uses the commands above.
