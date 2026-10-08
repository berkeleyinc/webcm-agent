# Builds the Alpine/RISC-V guest root filesystem used by the WebCM RISC-V machine.
# Based on edubart/webcm rootfs.Dockerfile, with agent-oriented packages added so
# autonomous agents get a real toolchain (compilers, nodejs, python, git, http).
FROM --platform=linux/riscv64 alpine:3.22.2 AS alpine-base

RUN apk update && \
    apk upgrade -aU

################################
# Toolchain stage (native riscv64 via qemu binfmt)
FROM alpine-base AS toolchain-stage
RUN apk add build-base pkgconf git wget patchelf
WORKDIR /root

################################
# xhalt: tool used by cartesi-init to poweroff the machine
FROM toolchain-stage AS xhalt-stage
RUN apk add libseccomp-dev
RUN wget -O xhalt.c https://raw.githubusercontent.com/cartesi/machine-guest-tools/refs/tags/v0.17.2/sys-utils/xhalt/xhalt.c
RUN gcc xhalt.c -Os -s -o xhalt
RUN mkdir -p /pkg/usr/sbin && \
    cp xhalt /pkg/usr/sbin/ && \
    strip /pkg/usr/sbin/xhalt

################################
# https-proxy: guest-side proxy that tunnels guest HTTP/HTTPS to a host callback
FROM toolchain-stage AS proxy-stage
RUN apk add boost-dev openssl-dev
COPY webcm/https-proxy https-proxy
RUN make -C https-proxy
RUN mkdir -p /pkg/usr/sbin /pkg/etc/ssl/webcm /pkg/etc/ssl/certs /pkg/usr/local/share/ca-certificates && \
    cp https-proxy/https-proxy /pkg/usr/sbin/https-proxy && \
    strip /pkg/usr/sbin/https-proxy

################################
# gcompat: run glibc programs on musl
FROM toolchain-stage AS gcompat-stage
RUN git clone --revision=d8cf7fbd072a379b9b16991539ba03bbbab4bd9c --depth=1 https://git.adelielinux.org/adelie/gcompat.git
RUN <<EOF cat >> gcompat/gcompat.patch
diff --git a/libgcompat/resolv.c b/libgcompat/resolv.c
index c63d074..35fe616 100644
--- a/libgcompat/resolv.c
+++ b/libgcompat/resolv.c
@@ -13,6 +13,10 @@
 
 #include "alias.h" /* weak_alias */
 
+int __res_init() {
+	return res_init();
+}
+
 int __res_ninit(res_state statp)
 {
 	int rc;
 
EOF
RUN cd gcompat && git apply gcompat.patch
RUN make -C gcompat -j$(nproc) LINKER_PATH=/lib/ld-musl-riscv64.so.1 LOADER_NAME=ld-linux-riscv64-lp64d.so.1
RUN make -C gcompat install LINKER_PATH=/lib/ld-musl-riscv64.so.1 LOADER_NAME=ld-linux-riscv64-lp64d.so.1 DESTDIR=/pkg

################################
# Root filesystem payload
FROM alpine-base AS rootfs-stage

# Base OS + interactive tools (matching upstream webcm)
RUN apk add \
    bash bash-completion \
    neovim \
    tree-sitter-lua tree-sitter-c tree-sitter-javascript tree-sitter-python tree-sitter-json tree-sitter-bash \
    tmux \
    htop ncdu vifm \
    strace dmesg \
    lua5.4 \
    quickjs \
    mruby \
    jq \
    bc \
    sqlite \
    micropython \
    tcc tcc-libs tcc-libs-static tcc-dev musl-dev \
    make \
    git \
    cmatrix \
    curl wget \
    libatomic

# Agent-oriented additions: real compilers and language runtimes for autonomy
RUN apk add \
    gcc g++ binutils gdb \
    nodejs npm \
    python3 py3-pip \
    perl ruby \
    openssh-client \
    file tar gzip xz zstd \
    ripgrep \
    procps \
    sudo \
    ca-certificates

RUN rm -rf /var/cache/apk /usr/lib/libc.a

# --- trim to fit the guest's 384MiB flash drive -------------------------------
# agent-critical parts of these packages stay: gcc/g++ themselves, nodejs,
# python3, git, rg. Removed: perl (18MiB of module trees), lto-dump (47MiB,
# a whole second middle-end), static archives (25MiB), docs/man/locales.
RUN apk del perl perl-utils perl-error ruby 2>/dev/null || true
RUN rm -rf \
    /usr/bin/lto-dump \
    /usr/lib/gcc/riscv64-alpine-linux-musl/*/plugin \
    /usr/lib/libstdc++.a /usr/lib/libstdc++exp.a /usr/lib/*.a \
    /usr/lib/gcc/riscv64-alpine-linux-musl/*/libgcc.a \
    /usr/lib/gcc/riscv64-alpine-linux-musl/*/include-fixed \
    /usr/bin/gdbserver \
    /usr/share/man /usr/share/misc /usr/share/doc /usr/share/zoneinfo \
    /usr/lib/python3.12/test /usr/lib/python3.12/idlelib /usr/lib/python3.12/tkinter /usr/lib/python3.12/lib2to3 \
    /usr/lib/python3.12/ensurepip /usr/lib/python3.12/pydoc_data \
    /usr/lib/python3.12/config-* \
    /usr/libexec/gcc/riscv64-alpine-linux-musl/*/install-tools \
    /usr/share/perl5 /usr/lib/perl5 \
    /usr/lib/debug \
    /usr/lib/node_modules/npm/docs /usr/lib/node_modules/npm/man \
    /usr/share/nvim/runtime/doc /usr/share/nvim/runtime/tutor


# Init system + guest skel
ADD --chmod=755 https://raw.githubusercontent.com/cartesi/machine-guest-tools/refs/tags/v0.17.2/sys-utils/cartesi-init/cartesi-init /usr/sbin/cartesi-init
COPY --from=xhalt-stage /pkg /
COPY --from=proxy-stage /pkg /
COPY --from=gcompat-stage /pkg /
COPY webcm/skel /
# Agent-specific guest provisioning (git identity, MOTD, helpers, workspace)
COPY guest-skel /
RUN ln -sf lua5.4 /usr/bin/lua && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    chmod +x /etc/profile.d/*.sh 2>/dev/null || true
