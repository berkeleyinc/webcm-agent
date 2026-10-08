# webcm/ is upstream, vendored

Source: https://github.com/edubart/webcm
Revision: 535541bb6aa00ec7d1f3e0e026427e2e66b7851b ("perf: 40% smaller https-proxy", 2025-11-13)

Vendored rather than used as a submodule so `make artifacts` works from a plain
`git clone` without network access to GitHub at checkout time. Upstream ships no
LICENSE file.

## Our edits

Two changes to `webcm.cpp` only; see `../patches/webcm.patch`:

1. `ROOTFS_SIZE` 384 -> 512 MiB (our guest image is much larger than upstream's).
2. `entrypoint` runs `stty onlcr` before `exec ash -l`, so the console is in the
   right mode before the MOTD is printed.

Everything else here is unmodified upstream. `make sync-upstream` re-fetches it.

## Files not from upstream

`linux.bin`, `linux.bin.zz`, `rootfs.ext2`, `rootfs.ext2.zz`, `rootfs.tar` and
`emscripten-pty.js` are build outputs and are git-ignored.
