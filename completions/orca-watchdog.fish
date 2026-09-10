# fish completion for orca-watchdog

# The command takes no filename arguments.
complete -c orca-watchdog -f

set -l cmds doctor start stop pause resume status logs

# Top-level commands (offered until a subcommand has been typed).
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -a doctor -d 'Check macOS, Node, Orca, launchd, pause, and event state'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -a start -d 'Validate and register the LaunchAgent'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -a stop -d 'Unregister the LaunchAgent'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -a pause -d 'Disable all watchdog activity without deleting state'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -a resume -d 'Re-enable watchdog activity'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -a status -d 'Show service health, pause state, and active events'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -a logs -d 'Show recent activity or launchd output (read-only)'

# Top-level flags.
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -l help -d 'Show help'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -l version -d 'Show the installed version'
complete -c orca-watchdog -n "not __fish_seen_subcommand_from $cmds" -l dry-run -d 'Run one observation-only tick'

# Options for the 'logs' command.
complete -c orca-watchdog -n "__fish_seen_subcommand_from logs" -l follow -d 'Follow the log as it grows'
complete -c orca-watchdog -n "__fish_seen_subcommand_from logs" -l lines -r -d 'Number of trailing lines to show'
complete -c orca-watchdog -n "__fish_seen_subcommand_from logs" -l source -r -d 'Which log stream to read' -a 'activity stdout stderr'
