# bash completion for orca-watchdog
# Self-contained: does not depend on the bash-completion framework being loaded.
_orca_watchdog() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local commands="doctor start stop pause resume status logs --help --version --dry-run"

  # First token after the program name selects a command.
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  # Only the 'logs' command takes further options.
  if [[ "${COMP_WORDS[1]}" == "logs" ]]; then
    case "$prev" in
      --source)
        COMPREPLY=( $(compgen -W "activity stdout stderr" -- "$cur") )
        return
        ;;
      --lines)
        # Expects a positive integer; nothing to complete.
        return
        ;;
    esac
    COMPREPLY=( $(compgen -W "--follow --lines --source" -- "$cur") )
    return
  fi
}
complete -F _orca_watchdog orca-watchdog
