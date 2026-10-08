# webcm-agent — build and run.
#
# Everything heavy runs in containers; the host only needs GNU make + docker
# (plus riscv64 binfmt, registered once with `make binfmt`).
#
#   make artifacts   build the server-side VM (webcm.mjs/webcm.wasm) into server/agent
#   make up          build artifacts, then `docker compose up` the server
#   make test        end-to-end smoke test (boots a real VM in-process)
#   make binfmt      register riscv64 qemu binfmt on the host (needs root/docker)
#   make clean       drop built artifacts (keeps docker/build caches)
#
# Pipeline (all inside the builder image except the rootfs, which must run as
# riscv64 and therefore uses the host docker daemon):
#
#   docker/rootfs.Dockerfile   -> artifacts/rootfs.tar     (riscv64 Alpine guest)
#   artifacts/rootfs.tar       -> webcm/rootfs.ext2(.zz)   (xgenext2fs, 512MiB)
#   upstream release           -> webcm/linux.bin(.zz)
#   xterm-pty                  -> webcm/emscripten-pty.js
#   all of the above           -> artifacts/webcm.mjs/.wasm (em++, embeds the .zz)
#
# Sizing invariant: ROOTFS_SIZE in webcm/webcm.cpp >= the ext2 file size, and
# -sTOTAL_MEMORY must leave room for the guest RAM (256MiB) plus the emulator.

SHELL := /bin/bash
DC := docker compose
BUILDER_IMAGE := webcm-agent/builder:local
PIGZ_LEVEL ?= 6

# 512 MiB drive (and matching ROOTFS_SIZE in webcm.cpp)
ROOTFS_BLOCKS ?= 122880
ROOTFS_BLOCK_SIZE ?= 4096
# 1.5 GiB wasm heap: 512MiB drive + 256MiB RAM + emulator/stack overhead
WASM_MEMORY ?= 1536MB

EMCC_CFLAGS := -Oz -g0 -std=gnu++23 \
	-I/opt/emscripten-cartesi-machine/include \
	-L/opt/emscripten-cartesi-machine/lib \
	-lcartesi \
	--js-library=emscripten-pty.js \
	-Wall -Wextra -Wno-unused-function -Wno-c23-extensions \
	-sASYNCIFY \
	-sFETCH \
	-sSTACK_SIZE=4MB \
	-sTOTAL_MEMORY=$(WASM_MEMORY) \
	-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8

GUEST_SRC := $(shell find guest-skel -type f 2>/dev/null) $(shell find webcm/skel -type f 2>/dev/null) \
	$(shell find webcm/https-proxy -type f 2>/dev/null)

# In-container command runner (build context mounted at /mnt).
RUN := $(DC) run --rm builder

.PHONY: all artifacts rootfs wasm up down logs dev test test-agent test-repro shell binfmt patch-webcm sync-upstream clean distclean

all: artifacts

# --------------------------------------------------------------- host prepare
binfmt:
	docker run --privileged --rm tonistiigi/binfmt --install riscv64

# ------------------------------------------------------------- guest rootfs
# riscv64: needs the host docker daemon + binfmt, hence `docker build` here.
artifacts/rootfs.tar: docker/rootfs.Dockerfile docker/builder.Dockerfile $(GUEST_SRC)
	@mkdir -p artifacts
	docker build --platform=linux/riscv64 --progress=plain \
		--output=type=tar,dest=artifacts/rootfs.tar \
		-f docker/rootfs.Dockerfile .

# ext2 image + compression happen inside the builder image.
webcm/rootfs.ext2.zz: artifacts/rootfs.tar
	$(RUN) inner-rootfs

# --------------------------------------------------------------- wasm inputs
webcm/linux.bin:
	$(DC) run --rm --entrypoint wget builder -O /mnt/webcm/linux.bin \
		https://github.com/cartesi/machine-linux-image/releases/download/v0.20.0/linux-6.5.13-ctsi-1-v0.20.0.bin

webcm/linux.bin.zz: webcm/linux.bin
	$(DC) run --rm --entrypoint sh builder -c "cat /mnt/webcm/linux.bin | pigz -cz -$(PIGZ_LEVEL) > /mnt/webcm/linux.bin.zz"

webcm/emscripten-pty.js:
	$(DC) run --rm --entrypoint wget builder -O /mnt/webcm/emscripten-pty.js \
		https://raw.githubusercontent.com/mame/xterm-pty/f284cab414d3e20f27a2f9298540b559878558db/emscripten-pty.js

# ------------------------------------------------------------------ wasm build
artifacts/webcm.mjs artifacts/webcm.wasm: webcm/webcm.cpp webcm/rootfs.ext2.zz webcm/linux.bin.zz webcm/emscripten-pty.js docker/builder.Dockerfile
	$(RUN) inner-wasm
	@cp artifacts/webcm.mjs artifacts/webcm.wasm server/agent/
	@ls -lh server/agent/webcm.mjs server/agent/webcm.wasm

artifacts: artifacts/webcm.mjs
wasm: artifacts

# ---------------------------------------------------- rules used inside docker
# (invoked as `docker compose run --rm builder make inner-*`)
.PHONY: inner-rootfs inner-wasm
inner-rootfs:
	@test -f /mnt/artifacts/rootfs.tar || (echo "artifacts/rootfs.tar missing" && exit 1)
	xgenext2fs --faketime --allow-holes \
		--size-in-blocks $(ROOTFS_BLOCKS) --block-size $(ROOTFS_BLOCK_SIZE) \
		--bytes-per-inode 4096 --volume-label rootfs \
		--tarball /mnt/artifacts/rootfs.tar /mnt/webcm/rootfs.ext2
	cat /mnt/webcm/rootfs.ext2 | pigz -cz -$(PIGZ_LEVEL) > /mnt/webcm/rootfs.ext2.zz
	@ls -lh /mnt/webcm/rootfs.ext2 /mnt/webcm/rootfs.ext2.zz

inner-wasm:
	cd /mnt/webcm && em++ webcm.cpp -o /mnt/artifacts/webcm.mjs $(EMCC_CFLAGS)

# ------------------------------------------------------------------------ run
up: artifacts
	$(DC) up -d --build server
	@echo "server is up: http://localhost:$${WEB_PORT:-8095}"

down:
	$(DC) down

logs:
	$(DC) logs -f server

shell:
	$(DC) run --rm --entrypoint bash builder

# Run the server straight from source (no container); needs node 22+.
dev:
	AGENT_DIR=server/agent PUBLIC_DIR=server/public LOG_LEVEL=$${LOG_LEVEL:-info} node server/launcher.js

test:
	AGENT_DIR=server/agent PUBLIC_DIR=server/public node server/test/smoke.mjs

# Drive the LLM agent against a fresh VM and print every step.
test-agent:
	AGENT_DIR=server/agent PUBLIC_DIR=server/public node server/test/agent-only.mjs "$${GOAL:-create /root/workspace/primes.sh printing the first 20 primes, run it and show the output}"

# Exercise session suspend/resume (recipe replay) with a real VM.
test-repro:
	AGENT_DIR=server/agent PUBLIC_DIR=server/public node server/test/repro.mjs

# ------------------------------------------------------------------- upstream
# Re-fetch the vendored upstream checkout at the recorded revision and re-apply
# our patch. Only `webcm.cpp` is modified; see webcm/UPSTREAM.md.
UPSTREAM_REPO ?= https://github.com/edubart/webcm.git
UPSTREAM_REV  ?= 535541bb6aa00ec7d1f3e0e026427e2e66b7851b

sync-upstream:
	rm -rf /tmp/webcm-upstream
	git clone $(UPSTREAM_REPO) /tmp/webcm-upstream
	git -C /tmp/webcm-upstream checkout $(UPSTREAM_REV)
	rsync -a --delete --exclude .git/ /tmp/webcm-upstream/ webcm/
	git apply -p1 --directory=webcm patches/webcm.patch 2>/dev/null || \
		patch -p1 -d webcm < patches/webcm.patch
	@echo "webcm/ now at $(UPSTREAM_REV) with patches/webcm.patch applied"

# Record/verify our two edits to upstream webcm.cpp.
patch-webcm:
	git -C webcm diff > patches/webcm.patch
	@cat patches/webcm.patch

# ---------------------------------------------------------------------- clean
clean:
	rm -rf server/agent artifacts
	rm -f webcm/*.zz webcm/linux.bin webcm/emscripten-pty.js webcm/rootfs.ext2

distclean: clean
	$(DC) down -v
	-docker rmi $(BUILDER_IMAGE) webcm-agent/server:local
