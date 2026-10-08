# webcm-agent

**A private Linux VM per visitor, running server-side — with an LLM agent inside it.**

Every visitor gets their own RISC-V machine: a real Alpine Linux userland with a
compiler, a shell and a working network. An agent you point at a goal drives that
machine's shell, and you watch it work in the same terminal.

The machine is [webcm](https://github.com/edubart/webcm) — a RISC-V Linux built on
the Cartesi Machine emulator, compiled to WebAssembly. Upstream runs that wasm in
the browser; here it runs **in a server worker thread, one isolate per session**, so
sessions survive a closed tab, work continues headless, and the browser only ever
carries a byte stream plus a little control traffic.

```
browser ──ws: tty + control──► server ──worker_thread──► webcm.wasm  ──► guest ash
   ▲                              │                          │
   │                       session registry                  │ guest HTTP
   │                              │                          ▼
   └────ws: http.request─────►───┴──► server fetch ─────► internet
               (browser does the fetching only when the server cannot reach a host)
```

## Quick start

```sh
git clone <this repo> && cd webcm-agent
cp .env.example .env          # set LLM_BASE_URL / LLM_API_KEY (any OpenAI-compatible API)
make binfmt                   # once: riscv64 binfmt so the guest image can build
make artifacts                # build webcm.wasm + the guest rootfs in docker (~10 min, cached)
make up                       # docker compose up -> http://localhost:8095
```

The host needs only `make` and `docker`. Nothing is installed outside containers.

```sh
make test        # 16-check end-to-end smoke: boots a VM, execs, agent writes+runs a file
make test-agent  # drive the LLM agent at a fresh VM and print every step
make logs        # follow the server
make down        # stop
```

## What you get

* **A fresh machine per visitor.** Cookie → session → its own wasm instance, own
  heap, own filesystem state, own network budget. No sandbox is shared.
* **A real terminal.** xterm.js over a WebSocket to the guest tty; `nvim`, `htop`,
  `tmux`, `cmatrix` all work. Ctrl-C, SIGWINCH on resize, the lot.
* **An agent in that terminal.** Give it a goal; it plans, runs commands, reads
  output, and verifies its own work in a persistent shell (`cd` and `export`
  stick). Every step streams to watchers, newest first.
* **Server-side networking.** The guest reaches the real internet through the
  host: `apk add`, `git clone`, `curl` work unmodified, with no CORS in the way.
  If the server cannot reach a host the user can, the request is retried through
  the attached browser's `fetch`.
* **A virtual machine, not a container.** Emulated RV64GC; guest changes live in
  the VM's memory and vanish on reboot.

## Layout

| Path | Purpose |
| --- | --- |
| `server/src/` | the app: http api, ws, session registry, vm worker, guest http bridge, xhr shim, terminal emulator, agent loop |
| `server/public/` | the UI: terminal, agent panel, live timeline |
| `server/test/` | end-to-end smoke test and focused drivers |
| `docker/` | `builder.Dockerfile` (emscripten + Cartesi → wasm) and `rootfs.Dockerfile` (the guest image) |
| `guest-skel/` | guest provisioning copied into the image: prompt, `onlcr`, `webcm-agent-run`, workspace |
| `webcm/` | upstream, vendored (see `webcm/UPSTREAM.md`) |
| `patches/` | the two edits to upstream `webcm.cpp`, and why |
| `scripts/` | `vendor-web.sh` for the browser libraries |

## How it works

**Server-side VM.** `server/src/vm-worker.js` runs in a `worker_thread` and loads
`webcm.wasm`. The emulator's `main()` keeps running for the VM's entire life — the
module's default export resolves in ~2 s, *before* the guest has even booted — so
the worker implements the xterm-pty `slave` interface itself and speaks a small
message protocol with the main thread. The parent notices the machine's epilogue
(`Cycles: …` / `Halted`) and only then tears the instance down. Idle sessions are
suspended and rebuilt on re-attach, replaying a saved command recipe.

**Command execution.** The guest profile defines `webcm-agent-run <id> <base64>`,
sourced into the live login shell: it evaluates the snippet in that shell and
brackets the output with `__WAGENT_BEGIN/END` sentinels. The server types it as a
bracketed paste and resolves on the sentinel, so it gets a real exit code instead
of scraping a prompt. Timeouts, aborts and VM death all unwind cleanly.

**Guest networking.** The guest's `https-proxy` listens on a loopback address that
`/etc/resolv.conf` points at; outgoing requests raise a "soft yield" that the
emulator answers with a host-side HTTP request. In a browser that hook is
`XMLHttpRequest`, which Node lacks — `server/src/xhr-shim.js` supplies it, wired to
a `fetch` on the host. TLS is terminated in the guest, so no CA plumbing is needed.

**The agent.** A tool loop (`run_command`, `read_file`, `write_file`, `send_keys`,
`read_screen`, `restart_shell`, `finish`) against any OpenAI-compatible
`/chat/completions` endpoint. Broadcasts to all attached clients.

### Four things worth knowing

These cost real debugging time; they are the non-obvious parts of running webcm
outside a browser.

* **A pty never signals EOF.** A snippet that reads stdin without redirection
  (`cat $(which foo)` when the substitution is empty, `read x`, a pager) blocks
  forever, because completion is announced by a sentinel that never arrives.
  `Session.exec` sends one `^D` after 2 s of silence, a genuine EOF for the
  canonical-mode guest tty.
* **Completion is sentinel-based, never "quiet for N seconds".** A quiet-interval
  heuristic fires while a slow silent command (`find /`, `apk upgrade`) is still
  running. Nothing between the markers can look like a prompt — the echoed
  `webcm-agent-run <id> <base64>` blob contains no `#`/`$` — so prompt shape is used
  only to recover a lost sentinel (Ctrl-C, `exec`, a foreground program).
* **`stty onlcr`.** Upstream leans on xterm-pty's local echo for line handling; with
  a real `ash` the tty leaves ONLCR off, so `\n` never returns the cursor to column 0
  and all output stair-steps. Applied in three places: an init hook (before the
  MOTD), the login profile, and once at boot by the worker. The local terminal
  emulator also keeps `\r` in its transcript, so replay reproduces the screen.
* **Guest emission is ~1 byte per write.** One postMessage and one WebSocket frame
  per character would be ~1000 frames for a 1 KiB command. The worker coalesces
  output on an 8 ms timer.

## Configuration

Copy `.env.example` to `.env` — it is git-ignored, so keys stay local. Compose reads
it automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | (required) | agent brain; any OpenAI-compatible API |
| `LLM_CONTEXT_WINDOW` | `1048576` | transcript is trimmed to fit |
| `WEB_PORT` | `8095` | host port for the UI |
| `SESSION_MAX_RUNNING` | `8` | concurrent VMs; extra sessions queue |
| `SESSION_MAX_WALL_MS` | `1800000` | active VM wall-clock budget |
| `SESSION_IDLE_MS` | `900000` | session reaped after this long untouched |
| `SESSION_DETACH_MS` | `60000` | no client and no agent → suspend the VM |
| `SESSION_MEMORY_MIB` | `1536` | must match `TOTAL_MEMORY` in the build |
| `QUOTA_MAX_BRIDGE_BYTES` | `512Mi` | per-session guest network budget |
| `SERVE_WASM` | `true` | expose `/agent/*` so `?local=1` can run in-tab |

The guest's own limits live in `docker/rootfs.Dockerfile` and
`webcm/webcm.cpp` — keep `ROOTFS_SIZE` ≥ the ext2 size and `TOTAL_MEMORY` ≥ drive +
256 MiB of guest RAM.

## HTTP API

Cookie-scoped; one session per browser unless you pin one with
`?session=<id>&token=<token>`.

| Route | Notes |
| --- | --- |
| `GET /api/config` | session id, ws token, limits, llm status, recipes |
| `GET /api/session` | summary + screen snapshot |
| `POST /api/session/exec` | `{command}` → `{exitCode, output, durationMs}`, in the live shell |
| `POST /api/session/keys` | raw key bytes, for full-screen programs |
| `POST /api/session/restart` \| `/reset` | reboot the VM / brand new machine |
| `POST /api/agent` | `{goal, maxSteps, wait}` → run id; events stream over ws |
| `GET /api/agent/{id}` · `POST /api/agent/{id}/cancel` | poll · abort |
| `GET /api/sessions` · `GET /healthz` | all sessions · liveness + capacity |

## Limits

* Emulated RISC-V with no JIT: expect roughly an order of magnitude slower than
  native. Budget `SESSION_MEMORY_MIB` per concurrent session.
* What a guest can reach is bounded by the host's network, or the browser's when
  the fallback kicks in.
* Guest filesystem changes survive a reload (the session is server-side) but not
  **New machine** or a reboot.

## Development

```sh
make dev          # run the server from source on the host (needs node 22+)
make shell        # shell inside the builder container
make clean        # drop built artifacts, keep docker caches
make patch-webcm  # regenerate patches/webcm.patch from webcm/
make sync-upstream
```

There are no runtime npm dependencies on the server — Node builtins only — so
`node --check` and `make test` are the whole toolchain. The browser side uses
vendored xterm.js, so the UI works offline.

## License

MIT (see `LICENSE`). `webcm/` is upstream work — see `webcm/UPSTREAM.md`.
