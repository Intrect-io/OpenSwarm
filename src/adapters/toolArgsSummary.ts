export function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file': {
      // Include offset/limit so a chunked walk of a large file (advancing offsets
      // = legitimate investigation) is distinguishable from an identical re-read
      // (a real loop). Without this the log hides the signal needed to tell them
      // apart, and the turn-count nudge/maxTurns may cut a still-progressing read.
      const off = args.offset != null ? ` @${args.offset}` : '';
      const lim = args.limit != null ? `+${args.limit}` : '';
      return `${String(args.path ?? '')}${off}${lim}`;
    }
    case 'write_file':
      return String(args.path ?? '');
    case 'edit_file':
      return String(args.path ?? '');
    case 'search_files':
      return `"${args.pattern}" in ${args.path}`;
    case 'bash':
      return String(args.command ?? '').slice(0, 80);
    default:
      return '';
  }
}
