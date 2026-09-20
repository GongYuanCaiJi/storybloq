/**
 * How a ledger write is recognised at `tool.call`. The MCP names arrive
 * prefixed by their server, the CLI's own do not; the verb at the end is what
 * separates a write from a read.
 */
const MCP_PREFIX = "mcp__storybloq__";
const LEDGER_TOOL_PREFIX = "storybloq_";
const LEDGER_WRITE_VERB = /_(create|update|set|unset|add|init|snapshot|reinforce|supersede)$/;
/**
 * The built-in tools that can write a file, from this build's own tool table
 * (`BuiltinToolInputs` in claude-code.d.ts carries Edit, Write and
 * NotebookEdit; MultiEdit is named here for builds that have it, and costs
 * nothing where it does not exist).
 */
const MUTATING_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const BASH_TOOL = "Bash";
/**
 * The storybloq CLI's writing subcommands, the same verbs the tool names end
 * in, and how far after `storybloq` one still counts as the subcommand
 * (`storybloq note create`, so two words).
 */
const CLI_NAME = "storybloq";
const WRITE_VERBS = ["create", "update", "set", "unset", "add", "init", "snapshot", "reinforce", "supersede"];
const CLI_VERB_DEPTH = 2;
/**
 * The characters that are operators outside a quoted run, the runs of them
 * that cut one segment from the next, and the one that redirects.
 */
const OPERATOR_CHARACTERS = [";", "|", "&", "\n", ">", "<"];
const SEPARATOR_CHARACTERS = [";", "|", "&", "\n"];
const REDIRECT = ">";
/** `&>`, the other way of writing a redirect that takes both streams. */
const BOTH_STREAMS = "&>";
/** `<<` and `<<<`: past one, the line is a document rather than a command. */
const HEREDOC = "<<";
/** A leading `NAME=value`, which is an assignment and not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The few commands that only lead up to the one that runs. */
const WRAPPER_COMMANDS = new Set(["env", "npx", "time", "nice", "sudo", "command"]);
/**
 * The options of those that take a VALUE in the next word, per wrapper.
 *
 * `sudo -u someone storybloq ticket update` runs the CLI, and a reader that
 * steps over `-u` and stops at `someone` decides the command is a username.
 * `--option=value` is one word already and needs none of this.
 */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-h", "-p"],
  nice: ["-n"],
  env: ["-u", "-C", "-S"],
  time: ["-f", "-o"],
  npx: ["-p", "--package", "-c", "--call"],
};
/** The CLI's own global options that take the next word as their value. */
const CLI_VALUE_OPTIONS = ["--node", "--format", "--client"];
/** The shell commands that write, by what each of them writes. */
const COPY_COMMANDS = new Set(["cp", "install"]);
const MOVE_COMMAND = "mv";
const TEE_COMMAND = "tee";
const REMOVE_COMMAND = "rm";
const SED_COMMAND = "sed";
/** Where a path can arrive on a built-in file tool's event. */
const PATH_ARGUMENTS = ["file_path", "path", "notebook_path"] as const;
const STORY_DIR = ".story/";

/** One piece of a command line: an operator, or a word to be read as one. */
interface Token {
  readonly text: string;
  readonly operator: boolean;
}

/**
 * A command line read ONCE, quotes and escapes honoured, operators kept apart
 * from arguments.
 *
 * Splitting on separators before reading the quotes was the bug: `echo "x;
 * storybloq ticket update"` came apart into two segments and the second
 * looked like a CLI call, and `echo '>' .story/config.json` looked like a
 * redirect into the ledger. A separator, a redirect and a quote mark only
 * mean what they say OUTSIDE a quoted run, so there is one pass and it knows
 * which run it is in.
 *
 * An unterminated quote makes the REST of the line unreadable, not the whole
 * of it. Dropping everything was a regression: a heredoc writing a ticket
 * (`cat > .story/tickets/T-001.json <<'EOF'`) has a body full of apostrophes,
 * and so does a trailing `# that's it` comment, and the write on the line
 * before them stopped sweeping. So the tokens read before the bad quote
 * opened come back with `ok: false`, and the caller judges every segment that
 * closed before it and discards the one the quote is in.
 *
 * A heredoc operator ends the read for the same reason from the other side:
 * its head is a command and its body is data, so reading the body as shell
 * would take words out of a document and call them a write.
 */
/**
 * Steps over a heredoc's delimiter word, quoted or bare, and answers with the
 * index of its last character, the word its terminator line must equal, and
 * whether `<<-` allowed that line leading tabs.
 *
 * The delimiter's own quotes are opened and closed here rather than by the
 * lexer's, so `<<'EOF'` does not read as a quote left open and throw the rest
 * of the head away, and a backslash quotes the character after it as it does
 * in the shell.
 */
function afterHeredocDelimiter(command: string, from: number): { index: number; delimiter: string; dashed: boolean } {
  let index = from;
  let delimiter = "";
  let dashed = false;
  for (let word = 0; word < 2; word += 1) {
    while (index + 1 < command.length && (command[index + 1] === " " || command[index + 1] === "\t")) index += 1;
    let quote = "";
    while (index + 1 < command.length) {
      const character = command[index + 1]!;
      if (quote !== "") {
        index += 1;
        if (character === quote) quote = "";
        else delimiter += character;
        continue;
      }
      // A backslash quotes the next character of the delimiter, so `<<\\EOF`
      // ends at a line reading EOF. Keeping the backslash means the
      // terminator is never found and the rest of the script is read as body.
      if (character === "\\") {
        index += 1;
        const escaped = command[index + 1];
        if (escaped !== undefined) {
          delimiter += escaped;
          index += 1;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        index += 1;
        continue;
      }
      if (character === " " || character === "\t" || character === "\n" || OPERATOR_CHARACTERS.includes(character)) break;
      delimiter += character;
      index += 1;
    }
    // `<<-EOF` allows leading tabs on the terminator; `<<- EOF` writes the
    // dash as a word of its own, so one more word is read for it.
    if (!delimiter.startsWith("-")) break;
    dashed = true;
    delimiter = delimiter.slice(1);
    if (delimiter !== "") break;
  }
  return { index, delimiter, dashed };
}

/**
 * Where a heredoc's body ends: the index of the newline that closes its
 * terminator line, or -1 where the terminator never comes and the rest of the
 * command is body.
 *
 * The body is never read as shell, but what follows it is: a script that
 * writes a note and then updates a ticket is one Bash call, and stopping at
 * the body would lose the write.
 */
function afterHeredocBody(command: string, from: number, delimiter: string, dashed: boolean): number {
  let start = from + 1;
  while (start <= command.length) {
    const cut = command.indexOf("\n", start);
    const last = cut === -1;
    const end = last ? command.length : cut;
    let line = command.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (dashed) line = line.replace(/^\t+/, "");
    if (line === delimiter) return last ? command.length - 1 : end;
    if (last) return -1;
    start = end + 1;
  }
  return -1;
}

function lex(command: string): { tokens: Token[]; ok: boolean } {
  const tokens: Token[] = [];
  let text = "";
  let started = false;
  let quote = "";
  /** How many tokens were whole when the quote now open was opened. */
  let opened = 0;
  /**
   * A heredoc head is being read, so the next newline starts its body, and
   * the word that ends it. Two heredocs on one head line (`cat <<A <<B`) are
   * read as one body ending at the LAST delimiter, which is close enough: the
   * body is never read either way and what follows it still is.
   */
  let heredoc = false;
  let delimiter = "";
  let dashed = false;
  const flush = (): void => {
    if (started) tokens.push({ text, operator: false });
    text = "";
    started = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== "") {
      // Inside single quotes a backslash is a backslash; inside double quotes
      // it escapes the next character, as the shell reads them. (Bash keeps
      // the backslash before anything but $ \ " ` and a newline; this drops
      // it either way, which costs a character in a path nobody writes.)
      if (character === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        text += command[index];
        started = true;
        continue;
      }
      if (character === quote) quote = "";
      else {
        text += character;
        started = true;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index < command.length) {
        text += command[index];
        started = true;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      // Where the quote opened, so an unclosed one can give back what was
      // whole before it rather than nothing at all.
      quote = character;
      opened = tokens.length;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      flush();
      continue;
    }
    if (OPERATOR_CHARACTERS.includes(character)) {
      flush();
      let run = character;
      while (index + 1 < command.length && command[index + 1] === character) {
        run += character;
        index += 1;
      }
      // The body of a heredoc starts at the newline after its head and is
      // never read: it is a document, and a line of it that looks like a write
      // is prose someone is filing. What comes AFTER the terminator is shell
      // again, and dropping it was losing the write in the commonest script
      // Claude Code produces: a note written with `cat <<EOF`, then a ticket
      // updated on the line below its EOF.
      if (heredoc && run.startsWith("\n")) {
        const end = afterHeredocBody(command, index, delimiter, dashed);
        if (end === -1) return { tokens, ok: true };
        index = end;
        heredoc = false;
        tokens.push({ text: "\n", operator: true });
        continue;
      }
      // `<<` and `<<<`: the head is still a command and the REST OF ITS LINE
      // still counts, because `cat <<'EOF' > .story/tickets/T-001.json` writes
      // a ticket with the redirect sitting after the delimiter. So the
      // operator and its delimiter are stepped over and the line goes on being
      // read as shell.
      if (run.startsWith(HEREDOC)) {
        const head = afterHeredocDelimiter(command, index);
        index = head.index;
        // `<<<` is a here-string: its word IS the input, and there is no body
        // to step over.
        if (run === HEREDOC) {
          heredoc = true;
          delimiter = head.delimiter;
          dashed = head.dashed;
        }
        continue;
      }
      // `>&` and `&>` are one redirect written two ways, and a run of one
      // character would split them: the `&` would then cut the segment and
      // the redirect would lose its target. `2>&1` is the same shape and
      // still names no file of ours, so it neither sweeps nor cuts.
      if (run[0] === REDIRECT && command[index + 1] === "&") {
        run += "&";
        index += 1;
      } else if (run[0] === "&" && command[index + 1] === REDIRECT) {
        while (command[index + 1] === REDIRECT) {
          run += REDIRECT;
          index += 1;
        }
      }
      tokens.push({ text: run, operator: true });
      continue;
    }
    text += character;
    started = true;
  }
  flush();
  // An unclosed quote: give back what was already whole when it opened. The
  // word it started, and everything after, is not shell this can read.
  if (quote !== "") return { tokens: tokens.slice(0, opened), ok: false };
  return { tokens, ok: true };
}

/** A word that names something inside the ledger directory. */
function inLedger(word: string | undefined): boolean {
  return typeof word === "string" && word.includes(STORY_DIR);
}

/** The last path segment of a word, which is the name a command runs under. */
function basename(word: string): string {
  const cut = word.lastIndexOf("/");
  return cut === -1 ? word : word.slice(cut + 1);
}

/**
 * The command a segment actually runs, past the wrappers that only lead up to
 * one, and the arguments it was given.
 *
 * `storybloq` counts as the CLI only HERE, in executable position: `echo
 * storybloq ticket update` prints a sentence and writes nothing, and the two
 * read identically to anything that only looks for the word. The wrappers are
 * a named few (`env`, `npx`, `time`, `nice`, `sudo`, `command`) with their own
 * options and any leading `NAME=value` assignments stepped over. Anything
 * else in front of the command (`xargs`, a subshell, a substitution) is a
 * line this cannot read, and it returns nothing rather than guess.
 */
function executableOf(words: readonly string[]): { name: string; args: string[] } | null {
  let index = 0;
  for (;;) {
    while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
    if (index < words.length && WRAPPER_COMMANDS.has(basename(words[index]!))) {
      const takesValue = WRAPPER_VALUE_OPTIONS[basename(words[index]!)] ?? [];
      index += 1;
      while (index < words.length && words[index]!.startsWith("-")) {
        const option = words[index]!;
        index += 1;
        if (!option.includes("=") && takesValue.includes(option)) index += 1;
      }
      continue;
    }
    break;
  }
  if (index >= words.length) return null;
  return { name: words[index]!, args: words.slice(index + 1) };
}

/**
 * Did one segment of a command line write the ledger?
 *
 * Direction is the whole question. `cat .story/tickets/T-001.json > /tmp/x`
 * and `cp .story/tickets/T-001.json /tmp/x` both name the ledger and both
 * write a file, and neither changes a thing we draw; only where the ledger is
 * the DESTINATION has anything moved. So a redirect counts at its target and
 * a copy at its last operand. `mv` counts at either end, because moving a
 * ticket OUT of the ledger takes it off the board as surely as moving one in;
 * `tee` counts at any of its files, and `rm` and `sed -i` at the path they
 * are given.
 */
function segmentWrote(tokens: readonly Token[]): boolean {
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.operator) {
      words.push(token.text);
      continue;
    }
    // A redirect writes what follows it; `<` reads it, and the rest of the
    // operators never reach here (they are what the segments were cut on).
    if (token.text.startsWith(REDIRECT) || token.text.startsWith(BOTH_STREAMS)) {
      const target = tokens[index + 1];
      if (target !== undefined && !target.operator && inLedger(target.text)) return true;
      index += 1;
    }
  }

  const run = executableOf(words);
  if (run === null) return false;
  const name = basename(run.name);
  const args = run.args;

  // The CLI resolves `.story/` itself, so the command line need not name it;
  // what says it writes is the SUBCOMMAND. A verb further along is an
  // argument (`storybloq note list --tags update`) or prose in a flag's
  // value, and neither writes anything.
  if (name === CLI_NAME) {
    // Only the words that are SUBCOMMANDS count toward the depth: a global
    // option before the verb (`storybloq --node x ticket update`) would
    // otherwise push it out of reach and the write would go unseen.
    let depth = 0;
    for (let index = 0; index < args.length && depth < CLI_VERB_DEPTH; index += 1) {
      const word = args[index]!;
      if (word.startsWith("-")) {
        if (!word.includes("=") && CLI_VALUE_OPTIONS.includes(word)) index += 1;
        continue;
      }
      depth += 1;
      if (WRITE_VERBS.includes(word)) return true;
    }
    return false;
  }

  if (name === MOVE_COMMAND || name === TEE_COMMAND || name === REMOVE_COMMAND) return args.some(inLedger);
  if (COPY_COMMANDS.has(name)) return args.length >= 2 && inLedger(args[args.length - 1]);
  if (name === SED_COMMAND) return args.some((word) => word.startsWith("-i")) && args.some(inLedger);
  return false;
}

/**
 * Every segment of a command line, cut on the separators, each on its own.
 *
 * The last segment is judged only when the line was read to its end: where an
 * unterminated quote stopped the read, that segment is the one the quote is
 * in and there is no telling what it says.
 */
function commandWroteLedger(command: string): boolean {
  const { tokens, ok } = lex(command);
  let segment: Token[] = [];
  for (const token of tokens) {
    // `&>` opens with a separator character and is not one: it is a redirect,
    // and cutting the segment there would leave its target orphaned.
    if (token.operator && SEPARATOR_CHARACTERS.includes(token.text[0]!) && !token.text.startsWith(BOTH_STREAMS)) {
      if (segmentWrote(segment)) return true;
      segment = [];
      continue;
    }
    segment.push(token);
  }
  return ok && segmentWrote(segment);
}

/**
 * Did this tool call change the ledger?
 *
 * The question has to be answered from the tool NAME first, because a ledger
 * read is the common case and a sweep per read is the cost the chunked scan
 * exists to avoid. Reading a ticket, globbing `.story`, or catting a config
 * file all mention the directory and none of them change a thing.
 *
 *   tool                                              scan
 *   storybloq_* / mcp__storybloq__* whose last word   yes
 *     is a writing verb (ticket_update, meta_set)
 *   any other storybloq tool (status, list, get)      no
 *   Write, Edit, MultiEdit, NotebookEdit at a         yes
 *     path under .story/
 *   the same four anywhere else                       no
 *   Bash running the storybloq CLI in EXECUTABLE      yes
 *     position with a writing verb in SUBCOMMAND
 *      position (it resolves .story/ itself, so the
 *      command line need not name the directory)
 *   Bash writing INTO .story/ (a redirect whose       yes
 *     destination is there, cp whose last argument
 *      is, tee at one, rm or sed -i of one)
 *   Bash moving a file at either end of .story/       yes
 *     (mv out of it takes a ticket off the board
 *      as surely as mv into it puts one on)
 *   Bash reading .story/ and writing elsewhere        no
 *     (cat a ticket into /tmp, cp one out of it)
 *   Bash naming the CLI anywhere but executable       no
 *     position (echo storybloq ticket update), or
 *      inside quotes, or in a heredoc's body, or in
 *      the segment an unterminated quote is in
 *      (the segments that closed before it still
 *      count, one at a time)
 *   Bash otherwise (cat, ls, grep, git status,        no
 *     storybloq status, storybloq ticket list)
 *   Read, Glob, Grep, LS, anything else               no
 *
 * Bash is conservative by construction: what it cannot read confidently does
 * not sweep. A missed write costs one turn of staleness, since turn.complete
 * still scans; a false positive costs a stat sweep of the whole ledger for
 * every ledger read in the session, which is worse.
 *
 * Pure, and it reads only the few fields a path or a command arrives in, so a
 * Write of a megabyte is not serialized to answer a yes or no question.
 */
export function wroteLedger(e: any): boolean {
  const tool: unknown = e?.tool;
  if (typeof tool !== "string") return false;
  const bare = tool.startsWith(MCP_PREFIX) ? tool.slice(MCP_PREFIX.length) : tool;
  if (bare.startsWith(LEDGER_TOOL_PREFIX)) return LEDGER_WRITE_VERB.test(bare);
  if (tool === BASH_TOOL) {
    const command: unknown = e?.["command"];
    return typeof command === "string" && commandWroteLedger(command);
  }
  if (!MUTATING_FILE_TOOLS.has(tool)) return false;
  for (const key of PATH_ARGUMENTS) {
    const value: unknown = e?.[key];
    if (typeof value === "string" && value.includes(STORY_DIR)) return true;
  }
  return false;
}

/** Where the client seated the pane, as its Pane props say; null when they do not. */
