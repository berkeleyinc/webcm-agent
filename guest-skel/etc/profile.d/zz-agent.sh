# Agent-facing guest configuration. Sourced last (alphabetical order in /etc/profile.d)
# by login shells so it wins over the default color prompt.

export TERM=${TERM:-xterm-256color}

# Deterministic prompt: the server detects "command finished" from the
# __WAGENT_END_*__ sentinel, but a stable prompt still helps humans.
if [ -n "$ZSH_VERSION" ]; then
    PS1='%m [%~]# '
else
    PS1='\h [\w]# '
fi

# ---------------------------------------------------------------------------
# webcm-agent-run <id> <base64-script>
#
# Runs the decoded script inside the *current* shell (so `cd`, `export` and
# aliases persist across agent steps) and brackets its output with sentinels.
# ---------------------------------------------------------------------------
webcm-agent-run() {
    _wag_id="$1"
    _wag_script=$(printf '%s' "$2" | base64 -d 2>/dev/null)
    printf '\n__WAGENT_BEGIN_%s__\n' "$_wag_id"
    eval "$_wag_script"
    _wag_rc=$?
    printf '\n__WAGENT_END_%s_%s__\n' "$_wag_id" "$_wag_rc"
    unset _wag_id _wag_script _wag_rc
}

# Convenience for agents/humans: a scratch workspace.
if [ -d /root/workspace ]; then
    :
fi

# Keep the guest proxy env sane.
# The guest console needs ONLCR so `\n` also returns the cursor to column 0.
# Without it every line continues where the previous one ended (the terminal
# stair-steps). Upstream relies on xterm-pty's local echo path for this; we run
# a real shell, so ask the tty directly.
stty onlcr 2>/dev/null

export GIT_TERMINAL_PROMPT=0
export PYTHONUNBUFFERED=1
