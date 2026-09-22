import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import yargs from "yargs";
import * as register from "../../src/cli/register.js";

/**
 * `--mcp` is reserved. src/cli/index.ts starts the MCP server instead of the
 * CLI whenever that token appears ANYWHERE in argv, so a command option named
 * `mcp` can never reach its handler: `storybloq capability add ... --mcp x`
 * started a server that then waited on stdin (T-523, which renamed its flag to
 * `--mcp-tool`). This turns that trap into a rule for every command.
 *
 * The walk RUNS each register function against a REAL yargs instance, pulls
 * each command's builder out of yargs' own command table, runs it against a
 * fresh real instance the way yargs runs it (both values of the
 * `helpOrVersionSet` argument; a replacement instance adopted from a promise
 * and discarded otherwise, exactly as command.js does), then reads back the
 * keys yargs itself recorded. There is no model of yargs' API here on purpose. An earlier
 * version of this file stood a recorder in for yargs and modelled its methods
 * and argument shapes; a partial model of someone else's API kept drifting,
 * and three review rounds in a row found the same class of hole (a known
 * method with an unmodelled argument shape, and yargs awaiting builders).
 * Letting yargs do its own normalising removes the class: `.demand(1, ["mcp"])`
 * and a declaration made after an `await` inside a builder are both caught
 * here with no line written for either.
 *
 * The price is that the walk reads yargs internals (getInternalMethods,
 * getCommandInstance, getUsageInstance, getValidationInstance). That is
 * deliberate and it is checked: if a yargs upgrade moves them, `internalsOf`
 * throws with instructions instead of quietly covering nothing.
 */
const RESERVED = "mcp";
const INDEX_PATH = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

// The walk drives yargs through its own untyped internals; @types/yargs does
// not describe them, and that is the point of reading yargs rather than a model.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyYargs = any;

interface Registration {
  readonly command: string;
  readonly name: string;
}

const INTERNALS_MOVED =
  "reserved-option walk: the yargs internals it reads are gone (getInternalMethods / getCommandInstance / " +
  "getUsageInstance / getValidationInstance / getOptions / getGroups). This walk reads yargs' own stores on " +
  "purpose, so that there is no model of yargs to drift. Re-point internalsOf and collectKeys at the installed " +
  "yargs; do not delete the assertion, because a walk that reads nothing passes while covering nothing.";

function internalsOf(y: AnyYargs): { command: AnyYargs; usage: AnyYargs; validation: AnyYargs } {
  const methods = typeof y?.getInternalMethods === "function" ? y.getInternalMethods() : undefined;
  const command = methods?.getCommandInstance?.();
  const usage = methods?.getUsageInstance?.();
  const validation = methods?.getValidationInstance?.();
  if (
    typeof y?.getOptions !== "function" ||
    typeof y?.getGroups !== "function" ||
    typeof command?.getCommandHandlers !== "function" ||
    typeof usage?.getDescriptions !== "function" ||
    typeof validation?.getImplied !== "function" ||
    typeof validation?.getConflicting !== "function"
  ) {
    throw new Error(INTERNALS_MOVED);
  }
  return { command, usage, validation };
}

function isYargs(value: unknown): boolean {
  return !!value && typeof (value as AnyYargs).getInternalMethods === "function";
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

/**
 * Dictionaries in yargs' options record whose KEYS are option names, and lists
 * whose ENTRIES are. Read from yargs' own reset() (yargs-factory), which is the
 * one place that enumerates them all.
 *
 * `demandedCommands` is left out: it is keyed by `_`, never by an option name.
 * `configObjects` is left out too: those hold config VALUES merged into argv,
 * so `.config({ mcp: true })` supplies a value for a key it never declares, and
 * no `--mcp` option exists for a user to type.
 */
const KEY_DICTS = ["key", "alias", "default", "defaultDescription", "config", "choices", "narg", "demandedOptions", "deprecatedOptions"] as const;
const KEY_LISTS = ["array", "boolean", "string", "number", "count", "normalize", "skipValidation", "hiddenOptions", "local"] as const;

/**
 * Every key yargs recorded on one instance. `local` holds keys marked
 * non-global, which declares nothing by itself; it is read anyway, because
 * over-reading a reserved-name guard costs nothing and under-reading it is
 * the failure this file exists to prevent.
 */
function collectKeys(y: AnyYargs): Set<string> {
  const { usage, validation } = internalsOf(y);
  const options = y.getOptions() as Record<string, unknown>;
  const keys = new Set<string>();
  const add = (key: unknown): void => {
    if (typeof key === "string") keys.add(key);
  };
  for (const dict of KEY_DICTS) for (const key of Object.keys((options[dict] ?? {}) as object)) add(key);
  for (const aliases of Object.values((options.alias ?? {}) as Record<string, unknown>)) for (const alias of toList(aliases)) add(alias);
  for (const list of KEY_LISTS) for (const key of toList(options[list])) add(key);
  for (const group of Object.values(y.getGroups() as Record<string, unknown>)) for (const key of toList(group)) add(key);
  for (const key of Object.keys(usage.getDescriptions() ?? {})) add(key);
  for (const related of [validation.getImplied(), validation.getConflicting()]) {
    for (const [key, partners] of Object.entries((related ?? {}) as Record<string, unknown>)) {
      add(key);
      for (const partner of toList(partners)) add(partner);
    }
  }
  return keys;
}

/** yargs' own promise test (utils/is-promise.js): any thenable, not only a Promise. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Runs one command's builder the way yargs runs it, which is not the same as
 * awaiting it (command.js, applyBuilderUpdateUsageAndParse):
 *
 *   const builderOutput = builder(yargs.getInternalMethods().reset(aliases), helpOrVersionSet);
 *   if (isPromise(builderOutput)) { return builderOutput.then(output => { innerYargs = isYargsInstance(output) ? output : yargs; ...
 *
 * A replacement instance is adopted in the PROMISE branch only. A synchronous
 * builder's return value is discarded and yargs parses with the instance it
 * passed in, so `b => { b.option("mcp", {}); return yargs([]); }` really does
 * declare the reserved option. An unconditional await adopted that empty
 * replacement and reported nothing, which is the false negative this shape
 * exists to prevent. An object builder is applied key by key, as yargs does.
 *
 * `helpOrVersionSet` is the second argument yargs threads in (false on an
 * ordinary run, true once --help or --version is parsed). A builder may branch
 * on it; passing nothing made every such branch read `undefined` and skipped
 * whatever it declares.
 */
async function applyBuilder(builder: unknown, inner: AnyYargs, helpOrVersionSet: boolean): Promise<AnyYargs> {
  if (typeof builder === "function") {
    const out = (builder as (y: AnyYargs, helpOrVersionSet: boolean) => unknown)(inner, helpOrVersionSet);
    if (!isThenable(out)) return inner;
    const settled = await out;
    return isYargs(settled) ? settled : inner;
  }
  for (const [key, opts] of Object.entries((builder ?? {}) as Record<string, unknown>)) inner.option(key, opts);
  return inner;
}

/** Subcommands nest a few deep; the cap only stops a self-registering command from hanging the suite. */
const MAX_DEPTH = 8;

async function walkInstance(y: AnyYargs, path: readonly string[], out: Registration[]): Promise<void> {
  if (path.length > MAX_DEPTH) throw new Error(`reserved-option walk: command nesting past ${MAX_DEPTH} at ${path.join(" ")}`);
  const command = path.join(" ") || "(root)";
  for (const name of collectKeys(y)) out.push({ command, name });
  const handlers = internalsOf(y).command.getCommandHandlers() as Record<string, AnyYargs>;
  for (const [name, handler] of Object.entries(handlers)) {
    const sub = [...path, name];
    // Positionals named in the command string: yargs parses them itself and
    // accepts them as `--name` too, so they are option names like any other.
    for (const positional of [...toList(handler.demanded), ...toList(handler.optional)]) {
      for (const parsed of toList((positional as { cmd?: unknown }).cmd)) if (typeof parsed === "string") out.push({ command: sub.join(" "), name: parsed });
    }
    // Both values of `helpOrVersionSet`: an option a builder declares under
    // either branch is an option the CLI has, and the union is what a run of
    // the CLI could produce. Only a function builder can read it, so an object
    // builder is applied once.
    for (const helpOrVersionSet of typeof handler.builder === "function" ? [false, true] : [false]) {
      await walkInstance(await applyBuilder(handler.builder, yargs([]) as AnyYargs, helpOrVersionSet), sub, out);
    }
  }
}

function registerFunctions(): Array<[string, (y: AnyYargs) => unknown]> {
  return Object.entries(register)
    .filter(([name, value]) => /^register\w+Command$/.test(name) && typeof value === "function")
    .map(([name, value]) => [name, value as (y: AnyYargs) => unknown]);
}

/** Register functions are awaited too: one that declared after an `await` would otherwise escape. */
async function walk(fns: Array<[string, (y: AnyYargs) => unknown]> = registerFunctions()): Promise<Registration[]> {
  const out: Registration[] = [];
  for (const [, fn] of fns) {
    const root = yargs([]) as AnyYargs;
    const returned = await fn(root);
    await walkInstance(isYargs(returned) ? returned : root, [], out);
  }
  return out;
}

/**
 * The self-test below is no longer a test of a model of yargs; it is a test of
 * the COLLECTOR, which is the only part of the walk that could under-read.
 * Each row applies one real call to a real yargs instance, inside an async
 * command builder that awaits before declaring, and asks whether the collector
 * finds the key yargs stored.
 */
type Form = readonly [label: string, declare: (y: AnyYargs) => unknown];

const coerceFn = (value: unknown): unknown => value;

/** Forms that make yargs record `mcp`. The collector must find every one. */
const DECLARING_FORMS: readonly Form[] = [
  ["option(key, opts)", (y) => y.option("mcp", { type: "string" })],
  ["option({ key: opts })", (y) => y.option({ mcp: { type: "string" } })],
  ["options(key, opts)", (y) => y.options("mcp", { type: "string" })],
  ["options({ key: opts })", (y) => y.options({ mcp: { type: "string" } })],
  ["positional(key, opts)", (y) => y.positional("mcp", { type: "string" })],
  ["an alias string in option opts", (y) => y.option("tool", { alias: "mcp" })],
  ["an alias array in options opts", (y) => y.options({ tool: { alias: ["t", "mcp"] } })],
  ["alias(key, alias)", (y) => y.alias("tool", "mcp")],
  ["alias(key, [aliases])", (y) => y.alias("tool", ["t", "mcp"])],
  ["alias([keys], alias)", (y) => y.alias(["mcp"], "m")],
  ["alias({ key: [aliases] })", (y) => y.alias({ tool: ["mcp"] })],
  ["help(key)", (y) => y.help("mcp")],
  ["version(key, version)", (y) => y.version("mcp", "1.0.0")],
  ["array(key)", (y) => y.array("mcp")],
  ["array([keys])", (y) => y.array(["other", "mcp"])],
  ["boolean(key)", (y) => y.boolean("mcp")],
  ["boolean([keys])", (y) => y.boolean(["other", "mcp"])],
  ["choices(key, values)", (y) => y.choices("mcp", ["a"])],
  ["choices([keys], values)", (y) => y.choices(["other", "mcp"], ["a"])],
  ["choices({ key: values })", (y) => y.choices({ mcp: ["a"] })],
  ["coerce(key, fn)", (y) => y.coerce("mcp", coerceFn)],
  ["coerce([keys], fn)", (y) => y.coerce(["other", "mcp"], coerceFn)],
  ["coerce({ key: fn })", (y) => y.coerce({ mcp: coerceFn })],
  ["config(key)", (y) => y.config("mcp")],
  ["config([keys])", (y) => y.config(["other", "mcp"])],
  ["count(key)", (y) => y.count("mcp")],
  ["count([keys])", (y) => y.count(["other", "mcp"])],
  ["default(key, value)", (y) => y.default("mcp", "x")],
  ["default([keys], value)", (y) => y.default(["other", "mcp"], "x")],
  ["default({ key: value })", (y) => y.default({ mcp: "x" })],
  ["demand(key)", (y) => y.demand("mcp")],
  ["demand([keys])", (y) => y.demand(["other", "mcp"])],
  ["demand({ key: msg })", (y) => y.demand({ mcp: "needed" })],
  // The form the recorder skipped: an array second argument makes every entry a
  // demandOption even though the first argument is a command count (yargs-factory demand()).
  ["demand(count, [keys])", (y) => y.demand(1, ["mcp"])],
  ["demandOption(key)", (y) => y.demandOption("mcp")],
  ["demandOption([keys])", (y) => y.demandOption(["other", "mcp"])],
  ["demandOption({ key: msg })", (y) => y.demandOption({ mcp: "needed" })],
  ["deprecateOption(key, msg)", (y) => y.deprecateOption("mcp", "gone")],
  ["describe(key, text)", (y) => y.describe("mcp", "d")],
  ["describe([keys], text)", (y) => y.describe(["other", "mcp"], "d")],
  ["describe({ key: text })", (y) => y.describe({ mcp: "d" })],
  // `.global(keys, false)` declares nothing, but it does record the name; the
  // collector reads options.local, so it is seen. Over-reading is the safe side.
  ["global([keys], false)", (y) => y.global(["mcp"], false)],
  ["group(key, name)", (y) => y.group("mcp", "Group:")],
  ["group([keys], name)", (y) => y.group(["other", "mcp"], "Group:")],
  ["hide(key)", (y) => y.hide("mcp")],
  ["nargs(key, count)", (y) => y.nargs("mcp", 1)],
  ["nargs([keys], count)", (y) => y.nargs(["other", "mcp"], 1)],
  ["nargs({ key: count })", (y) => y.nargs({ mcp: 1 })],
  ["normalize(key)", (y) => y.normalize("mcp")],
  ["normalize([keys])", (y) => y.normalize(["other", "mcp"])],
  ["number(key)", (y) => y.number("mcp")],
  ["number([keys])", (y) => y.number(["other", "mcp"])],
  ["require(key)", (y) => y.require("mcp")],
  ["require([keys])", (y) => y.require(["other", "mcp"])],
  ["require({ key: msg })", (y) => y.require({ mcp: "needed" })],
  ["required(key)", (y) => y.required("mcp")],
  ["required([keys])", (y) => y.required(["other", "mcp"])],
  ["required({ key: msg })", (y) => y.required({ mcp: "needed" })],
  ["requiresArg(key)", (y) => y.requiresArg("mcp")],
  ["requiresArg([keys])", (y) => y.requiresArg(["other", "mcp"])],
  ["requiresArg({ key: count })", (y) => y.requiresArg({ mcp: 1 })],
  ["skipValidation(key)", (y) => y.skipValidation("mcp")],
  ["skipValidation([keys])", (y) => y.skipValidation(["other", "mcp"])],
  ["string(key)", (y) => y.string("mcp")],
  ["string([keys])", (y) => y.string(["other", "mcp"])],
  ["conflicts(key, other)", (y) => y.conflicts("tool", "mcp")],
  ["conflicts(key, [others])", (y) => y.conflicts("tool", ["x", "mcp"])],
  ["conflicts({ key: other })", (y) => y.conflicts({ tool: "mcp" })],
  ["conflicts({ key: [others] })", (y) => y.conflicts({ tool: ["x", "mcp"] })],
  ["implies(key, other)", (y) => y.implies("tool", "mcp")],
  ["implies(key, [others])", (y) => y.implies("tool", ["x", "mcp"])],
  ["implies({ key: other })", (y) => y.implies({ tool: "mcp" })],
  ["implies({ key: [others] })", (y) => y.implies({ tool: ["x", "mcp"] })],
  ["a command builder object", (y) => y.command("x", "d", { mcp: { type: "string" } })],
  ["a command module with a builder function", (y) => y.command({ command: "x", describe: "d", builder: (b: AnyYargs) => b.option("mcp", {}), handler: () => {} })],
  ["a nested command builder", (y) => y.command("x", "d", (b: AnyYargs) => b.command("y", "d", (c: AnyYargs) => c.boolean("mcp"), () => {}), () => {})],
  ["a positional in the command string", (y) => y.command("x <mcp>", "d", (b: AnyYargs) => b, () => {})],
  ["an async builder that returns a different instance", (y) => y.command("x", "d", async () => yargs([]).option("mcp", { type: "string" }), () => {})],
  // yargs discards a SYNCHRONOUS builder's return value and parses with the
  // instance it handed in, so this declares `mcp` on the instance that counts.
  [
    "a synchronous builder that declares on the instance yargs keeps and returns another",
    (y) =>
      y.command(
        "x",
        "d",
        (b: AnyYargs) => {
          b.option("mcp", { type: "string" });
          return yargs([]);
        },
        () => {},
      ),
  ],
  ["a builder that declares only when helpOrVersionSet is false", (y) => y.command("x", "d", (b: AnyYargs, help: boolean) => (help === false ? b.option("mcp", { type: "string" }) : b), () => {})],
  ["a builder that declares only when helpOrVersionSet is true", (y) => y.command("x", "d", (b: AnyYargs, help: boolean) => (help === true ? b.option("mcp", { type: "string" }) : b), () => {})],
];

/**
 * Forms that record nothing yargs would answer `--mcp` with. Each is a real
 * call; the collector must NOT report it, or the rows above could be passing
 * on something other than the declaration they name.
 */
const NON_DECLARING_FORMS: readonly Form[] = [
  ["example(text, text)", (y) => y.example("mcp", "mcp")],
  ["epilogue(text)", (y) => y.epilogue("mcp")],
  ["strict()", (y) => y.strict()],
  ["check(fn)", (y) => y.check(() => true)],
  ["demandCommand(count, msg)", (y) => y.demandCommand(1, "mcp")],
  ["demand(count, msg)", (y) => y.demand(1, "mcp")],
  ["config()", (y) => y.config()],
  // A config OBJECT supplies values, not a declaration: no --mcp option exists.
  ["config({ key: value })", (y) => y.config({ mcp: true })],
  ["help()", (y) => y.help()],
  ["help(false)", (y) => y.help(false)],
  ["version(version)", (y) => y.version("mcp")],
  ["version(false)", (y) => y.version(false)],
  ["global(key)", (y) => y.global("mcp")],
  // yargs prints an argsert complaint for these and records a garbage entry
  // (a joined key, a nested array, a nested object). No option is declared.
  ["deprecateOption([keys], msg)", (y) => y.deprecateOption(["other", "mcp"], "gone")],
  ["hide([keys])", (y) => y.hide(["other", "mcp"])],
  ["group({ key: value }, name)", (y) => y.group({ mcp: true }, "Group:")],
  ["normalize({ key: value })", (y) => y.normalize({ mcp: true })],
  ["skipValidation({ key: value })", (y) => y.skipValidation({ mcp: true })],
  // The mirror of the synchronous-replacement row above: yargs never parses
  // with the instance a synchronous builder returns, so nothing declared on it
  // is an option of this CLI. Reporting it would be a false positive from the
  // same modelling mistake.
  ["a synchronous builder that declares only on the instance it returns", (y) => y.command("x", "d", (_b: AnyYargs) => yargs([]).option("mcp", { type: "string" }), () => {})],
  ["another option only", (y) => y.option("tool", { type: "string" })],
];

/** Forms yargs itself cannot take: the walk must fail loudly, never pass quietly. */
const REFUSED_FORMS: readonly Form[] = [
  ["array({ key: value })", (y) => y.array({ mcp: true })],
  ["boolean({ key: value })", (y) => y.boolean({ mcp: true })],
  ["count({ key: value })", (y) => y.count({ mcp: true })],
  ["number({ key: value })", (y) => y.number({ mcp: true })],
  ["string({ key: value })", (y) => y.string({ mcp: true })],
];

/**
 * Every form is exercised through an async command builder that awaits before
 * declaring. yargs awaits builders (command.js), so a walk that did not would
 * see nothing at all here.
 */
async function walkedNames(declare: Form[1]): Promise<string[]> {
  const registrations = await walk([
    [
      "form",
      (y: AnyYargs) =>
        y.command(
          "c",
          "d",
          async (b: AnyYargs) => {
            await null;
            return declare(b);
          },
          () => {},
        ),
    ],
  ]);
  return registrations.map((r) => r.name);
}

describe("--mcp is reserved by the entry point", () => {
  it("reads the yargs internals the walk depends on", () => {
    expect(() => internalsOf(yargs([]) as AnyYargs), INTERNALS_MOVED).not.toThrow();
    expect(() => internalsOf({}), "internalsOf must refuse an instance without them").toThrow(/reserved-option walk/);
  });

  it.each(DECLARING_FORMS)("the walk sees a key declared through %s", async (_label, declare) => {
    expect(await walkedNames(declare)).toContain(RESERVED);
  });

  it.each(NON_DECLARING_FORMS)("the walk reports nothing for %s, which declares no option", async (_label, declare) => {
    expect(await walkedNames(declare)).not.toContain(RESERVED);
  });

  it.each(REFUSED_FORMS)("the walk fails loudly on %s, which yargs itself refuses", async (_label, declare) => {
    await expect(walkedNames(declare)).rejects.toThrow();
  });

  it("awaits the register function too, not only the builder", async () => {
    const names = await walk([
      [
        "asyncRegister",
        async (y: AnyYargs) => {
          await null;
          return y.command("c", "d", (b: AnyYargs) => b.option("mcp", { type: "string" }), () => {});
        },
      ],
    ]);
    expect(names.map((r) => r.name)).toContain(RESERVED);
  });

  it("covers every function the entry point hands `cli` to, however the call is spelled", () => {
    const { handed, offending } = classifyCliReferences();
    expect(handed.length, "the entry point must still be handing `cli` to the register functions").toBeGreaterThan(30);
    expect(
      offending,
      "every use of `cli` in src/cli/index.ts must be one the walk covers: a call to a walked register function, " +
        "a method call on the chain (checked separately), or one of READS_ONLY. Anything else can declare an " +
        "option this guard never sees.",
    ).toEqual([]);
  });

  it("the entry point's own chain, which the walk cannot run, calls only methods that declare no option", () => {
    // index.ts binds `cli` to a chain the walk cannot execute (it needs real argv and a real parse),
    // so this is a claim about OUR file, made by AST and checked by exact equality: each method below
    // declares no option key at the arity it is called with. `.version(version)` passes a version
    // string, `.help()` is bare; `.version("mcp", "1.0.0")` or `.help("mcp")` would change the arity
    // and fail here. A method added to the chain fails this test until someone states its claim.
    // `catch/1` is `cli.parseAsync().catch(handleUnexpectedError)`: the chain continues past the
    // parse onto the promise it returns, and Promise.prototype.catch is not a yargs method at all.
    const READS_ONLY_ON_CHAIN = ["catch/1", "demandCommand/2", "fail/1", "help/0", "locale/1", "middleware/1", "parseAsync/0", "scriptName/1", "strict/0", "version/1", "wrap/1"];
    expect(chainMethodCalls().sort()).toEqual(READS_ONLY_ON_CHAIN);
  });

  it("actually sees options, including wrapper-built ones, so a clean result is not an empty walk", async () => {
    const keys = new Set((await walk()).map((r) => `${r.command} --${r.name}`));
    expect(keys.has("capability add --mcp-tool")).toBe(true);
    expect(keys.has("capability update --mcp-tool")).toBe(true);
    expect(keys.has("capability match --format")).toBe(true);
    expect(keys.has("ticket create --blocked-by")).toBe(true);
  });

  it("no command registers an option or alias named `mcp`", async () => {
    const offending = (await walk())
      .filter((r) => r.name === RESERVED)
      .map((r) => `${r.command} --${r.name}`);
    expect(
      offending,
      "--mcp is reserved: src/cli/index.ts starts the MCP server when that token appears anywhere in argv, " +
        "so an option named mcp never reaches its command and the process sits on stdin instead. Name it something else " +
        "(capability uses --mcp-tool).",
    ).toEqual([]);
  });
});

/** Functions the entry point hands `cli` to that only READ it. A claim, like the walk's: stated, not assumed. */
const READS_ONLY = new Set(["buildUsageInfo"]);

function indexSource(): ts.SourceFile {
  return ts.createSourceFile(INDEX_PATH, readFileSync(INDEX_PATH, "utf-8"), ts.ScriptTarget.ESNext, true);
}

/** `cli`, `cli as unknown as X`, `(cli)`: the expression an argument is really passing. */
function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The same wrappers, climbed the other way: `cli` inside `cli as unknown as X` reaches the argument itself. */
function outermost(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent &&
    (ts.isAsExpression(current.parent) || ts.isParenthesizedExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) || ts.isSatisfiesExpression(current.parent)) &&
    (current.parent as ts.AsExpression | ts.ParenthesizedExpression).expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) return callee.argumentExpression.text;
  return null;
}

/**
 * Classifies EVERY reference to `cli` in the entry point. The old text scan only
 * saw `f(cli` as a first argument, so a call that passed it second, or through a
 * helper, was invisible.
 */
function classifyCliReferences(): { handed: string[]; offending: string[] } {
  const source = indexSource();
  const walked = new Set(registerFunctions().map(([name]) => name));
  const handed: string[] = [];
  const offending: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "cli") {
      const parent = node.parent;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const describe = (): string => `${line}: ${parent.getText().split("\n")[0]!.slice(0, 80)}`;
      if (ts.isVariableDeclaration(parent) && parent.name === node) {
        // `let cli = yargs(rawArgs)...`: the chain is checked by chainMethodCalls().
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        // A method call on `cli`: also the chain's business.
      } else if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const assigned = unwrap(parent.right);
        const name = ts.isCallExpression(assigned) ? calleeName(assigned) : null;
        if (name === null || !walked.has(name)) offending.push(describe());
      } else {
        const argument = outermost(node);
        const call = argument.parent && ts.isCallExpression(argument.parent) && argument.parent.arguments.some((arg) => arg === argument) ? argument.parent : null;
        const passedTo = call ? calleeName(call) : null;
        if (passedTo !== null && walked.has(passedTo)) handed.push(passedTo);
        else if (passedTo === null || !READS_ONLY.has(passedTo)) offending.push(describe());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { handed, offending };
}

/** Every method called on `cli`, in its declaration's chain or later, as `name/argumentCount`. */
function chainMethodCalls(): string[] {
  const source = indexSource();
  const calls = new Set<string>();
  const record = (node: ts.Node): void => {
    // The declaration's chain: `yargs(rawArgs).scriptName(...)...`, walked inward from the tail.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      calls.add(`${node.expression.name.text}/${node.arguments.length}`);
      record(node.expression.expression);
    } else if (ts.isPropertyAccessExpression(node)) {
      record(node.expression);
    }
  };
  /**
   * Outward from one `cli` reference, through every method chained onto it.
   * `cli.help().option("mcp", {})` calls two methods on the instance and only
   * the first has `cli` for a receiver; recording that one alone let the rest
   * of the chain declare whatever it liked, and the walk cannot catch it
   * either, because it never executes the entry point. An element access is
   * recorded under its literal name, or as `[computed]` when it has none, so
   * an indexed call breaks the claim below instead of slipping past it.
   */
  const recordChain = (start: ts.Node): void => {
    let current: ts.Node = start;
    for (;;) {
      const parent: ts.Node | undefined = current.parent;
      if (parent === undefined) return;
      const callOf = (receiver: ts.Node): ts.CallExpression | null =>
        receiver.parent !== undefined && ts.isCallExpression(receiver.parent) && receiver.parent.expression === receiver ? receiver.parent : null;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
        const call = callOf(parent);
        calls.add(`${parent.name.text}/${call ? call.arguments.length : "read"}`);
        current = call ?? parent;
        continue;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === current) {
        const call = callOf(parent);
        const name = ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : "[computed]";
        calls.add(`${name}/${call ? call.arguments.length : "read"}`);
        current = call ?? parent;
        continue;
      }
      // The wrappers a chain can be written through, climbed so the chain continues.
      if (
        (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent) || ts.isAwaitExpression(parent)) &&
        parent.expression === current
      ) {
        current = parent;
        continue;
      }
      return;
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "cli" && node.initializer) record(node.initializer);
    if (ts.isIdentifier(node) && node.text === "cli" && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) recordChain(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...calls];
}
