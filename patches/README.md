# patches/

`webcm.patch` — our two edits to upstream `webcm/webcm.cpp`:

1. `ROOTFS_SIZE` 384 -> 512 MiB. Our agent-oriented root filesystem is far bigger
   than upstream's, and the drive must be >= the `rootfs.ext2` file size.
2. entrypoint runs `stty onlcr` before `exec ash -l` so the console turn-on of
   ONLCR happens before the MOTD is printed.

Regenerate with `git -C webcm diff > patches/webcm.patch`.
