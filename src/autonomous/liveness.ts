import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_BASENAME = "sidecar.lock";
const PID_BASENAME = "sidecar.pid";
const ACQUIRE_DEADLINE_MS = 2_000;
const ACQUIRE_POLL_MS = 25;
const STALENESS_FLOOR_MS = 5_000;
const UNREADABLE_BREAK_MS = 10 * STALENESS_FLOOR_MS;
const KILL_GRACE_MS = 500;
const KILL_POLL_MS = 50;
const LOCK_MAX_BYTES = 4_096;
const CMDLINE_MAX_BYTES = 128 * 1024;
const SIDECAR_SENTINEL = "CLAUDESTORY_SIDECAR_V1";
const SIDECAR_ARGV_MARKER = "--" + SIDECAR_SENTINEL.toLowerCase().replace(/_/g, "-");
const SIDECAR_PID_MAX_BYTES = 64;

// Mutable indirection so tests can replace methods (vi.spyOn cannot mock ESM
// module-namespace exports directly).
const fsApi = {
  linkSync: fs.linkSync,
  renameSync: fs.renameSync,
};

interface LockBody { pid: number; token: string; acquiredAt: number; }
interface LockHandle { token: string; lockPath: string; tmpPath: string; lockIno: number | null; }
type LockState = "holder-alive" | "holder-grace" | "holder-dead" | "unreadable";
interface LockInspection { state: LockState; ino: number | null; token: string | null; }

const SIDECAR_SCRIPT = [
  `// ${SIDECAR_SENTINEL}`,
  'const fs=require("fs"),path=require("path");',
  "const dir=process.argv[1],ms=+process.argv[2],ppid=process.ppid;",
  'const alive=path.join(dir,"alive"),shut=path.join(dir,"shutdown");',
  "const tick=()=>{",
  "  if(process.ppid!==ppid){try{fs.writeFileSync(alive,\"0\")}catch{}process.exit(0)}",
  "  if(fs.existsSync(shut)){try{fs.writeFileSync(alive,\"0\")}catch{}process.exit(0)}",
  "  try{fs.writeFileSync(alive,String(Date.now()))}catch{}",
  "};",
  "tick();setInterval(tick,ms);",
].join("\n");

if (!SIDECAR_SCRIPT.includes(SIDECAR_SENTINEL)) {
  throw new Error(
    "liveness.ts: SIDECAR_SCRIPT lost sentinel " + SIDECAR_SENTINEL +
    " \u2014 PID-reuse guard cannot match the sidecar in ps/proc output; refusing to load."
  );
}

function livenessLog(tag: string, detail: Record<string, unknown>): void {
  const debug = process.env.STORYBLOQ_LIVENESS_DEBUG ?? process.env.CLAUDESTORY_LIVENESS_DEBUG;
  if (debug !== "1") return;
  try { process.stderr.write("liveness:" + tag + " " + JSON.stringify(detail) + "\n"); } catch { /* best-effort */ }
}

export function sleepMs(ms: number): void {
  if (ms <= 0) return;
  const deadline = Date.now() + ms;
  try {
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    // Loop because Atomics.wait can return early (not-equal, ok, or
    // spurious wakeups on some platforms); honor the full requested sleep.
    let remaining = ms;
    while (remaining > 0) {
      Atomics.wait(i32, 0, 0, remaining);
      remaining = deadline - Date.now();
    }
  } catch {
    while (Date.now() < deadline) { /* bounded busy-wait fallback */ }
  }
}

function safeStatIno(p: string): number | null {
  try { return fs.statSync(p).ino; } catch { return null; }
}

function randomHex4(): string {
  return randomBytes(2).toString("hex");
}

function getOurUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function isSelfPid(pid: number): boolean {
  return pid === process.pid || pid === process.ppid || pid === 1;
}

function getProcessPpid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], {
        encoding: "utf-8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const n = Number(out.trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const rp = raw.lastIndexOf(")");
      if (rp < 0) return null;
      const rest = raw.slice(rp + 1).trim().split(/\s+/);
      const n = Number(rest[1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Same-uid argv-marker check: true only when `pid` is alive, owned by our uid,
 * and its command line carries EVERY one of `markers` (all-markers semantics:
 * a process matching only some markers -- e.g. an interactive `claude --resume
 * <id>` sharing the session UUID with a wake child -- is a non-match). Bare
 * kill(pid,0) liveness is NOT PID-reuse-safe; this is the identity layer that
 * makes it safe. Exported for T-424 (waker sentinel + wake-child identity).
 */
export function hasArgvSignature(pid: number, markers: readonly string[]): boolean {
  return probeArgvSignature(pid, markers) === "match";
}

/**
 * Tri-state argv identity probe. "match" = the process exists, belongs to us,
 * and carries EVERY marker. "absent" = the process is gone, belongs to another
 * uid, or its (readable) argv lacks a marker -- i.e. the identified child is
 * definitively not there (dead or PID-reused). "unknown" = the process EXISTS
 * (kill(pid, 0) reaches it) but its argv could not be inspected (ps failure,
 * truncated /proc read, unsupported platform); callers supervising a child
 * must treat "unknown" as possibly-alive and retry, never as confirmed death.
 */
export function probeArgvSignature(pid: number, markers: readonly string[]): "match" | "absent" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "absent";
  if (markers.length === 0) return "absent";
  let exists = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return "absent";
    // EPERM: exists but not ours -> the uid checks below would reject it
    // anyway; treat as PID reuse by another user.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return "absent";
    exists = false; // unexpected failure: fall through to argv inspection
  }
  try {
    if (process.platform === "darwin") {
      // `-ww` = unlimited width: without it BSD `ps` truncates the command
      // column (~default width), which would drop a marker that sits near the
      // END of a long argv -- e.g. the wake-child attempt sentinel at the tail
      // of a ~280-char prompt -- making a LIVE child read as "absent" (a
      // positively-confirmed death). That would let the supervisor spawn a
      // second child on the same transcript. Full width keeps every marker
      // visible so all-markers matching is sound.
      const out = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=,command="], {
        encoding: "utf-8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const line = out.trim();
      if (!line) return exists ? "unknown" : "absent";
      const firstSpace = line.indexOf(" ");
      if (firstSpace < 0) return "unknown";
      const uid = Number(line.slice(0, firstSpace).trim());
      const command = line.slice(firstSpace + 1);
      const myUid = getOurUid();
      if (myUid < 0) return "unknown";
      if (uid !== myUid) return "absent";
      return markers.every((m) => command.includes(m)) ? "match" : "absent";
    }
    if (process.platform === "linux") {
      const pidDir = "/proc/" + pid;
      const st1 = fs.statSync(pidDir);
      const myUid = getOurUid();
      if (myUid < 0) return "unknown";
      if (st1.uid !== myUid) return "absent";
      const fd = fs.openSync(pidDir + "/cmdline", "r");
      try {
        // procfs cmdline reports st_size 0, so size the buffer at the cap. A
        // single readSync can also SHORT-read; loop until EOF or the cap. If the
        // cap fills WITHOUT EOF a required marker may lie beyond it -> return
        // "unknown" (possibly-alive), NEVER "absent" (a false confirmed death
        // would let the supervisor spawn a second child on the same transcript).
        const buf = Buffer.alloc(CMDLINE_MAX_BYTES);
        let read = 0;
        let sawEof = false;
        while (read < buf.length) {
          const n = fs.readSync(fd, buf, read, buf.length - read, read);
          if (n <= 0) { sawEof = true; break; }
          read += n;
        }
        const st2 = fs.statSync(pidDir);
        if (st2.uid !== st1.uid || st2.ino !== st1.ino) return "unknown";
        if (!sawEof) return "unknown"; // cap filled before EOF: cannot rule out a marker past it
        const cmd = buf.slice(0, read).toString("utf-8").replace(/\0/g, " ");
        return markers.every((m) => cmd.includes(m)) ? "match" : "absent";
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    // Unsupported platform: existence is known, identity is not.
    return "unknown";
  } catch {
    // ps/proc inspection failed while kill(pid, 0) says the process exists:
    // identity is unknown -- do NOT report a live pid as absent.
    return exists ? "unknown" : "absent";
  }
}

function hasSidecarSignature(pid: number): boolean {
  // ANY-marker contract (preserved from the pre-T-424 implementation): the
  // osascript sidecar command line is long and `ps -o command=` can truncate
  // it, so a live sidecar may show only one of the two markers. Requiring BOTH
  // (all-markers) would misclassify such a sidecar as absent and let it be
  // replaced/killed. All-markers semantics are correct only for wake-child
  // identity (session UUID + attempt id must both be present); the sidecar
  // deliberately matches on either. `||` short-circuits, so the common
  // both-markers-present case stays a single probe.
  return hasArgvSignature(pid, [SIDECAR_ARGV_MARKER]) || hasArgvSignature(pid, [SIDECAR_SENTINEL]);
}

function waitForExit(pid: number, deadlineMs: number, signatureGuard: () => boolean): "exited" | "timeout" | "lost-signature" {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try { process.kill(pid, 0); }
    catch (e: any) { if (e && e.code === "ESRCH") return "exited"; }
    if (!signatureGuard()) return "lost-signature";
    sleepMs(KILL_POLL_MS);
  }
  return "timeout";
}

function inspectExistingLock(lockPath: string): LockInspection {
  try {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      return { state: "unreadable", ino: null, token: null };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { state: "unreadable", ino: st.ino ?? null, token: null };
      const myUid = getOurUid();
      if (myUid >= 0 && st.uid !== myUid) return { state: "unreadable", ino: st.ino, token: null };
      if (st.size > LOCK_MAX_BYTES || st.size < 0) return { state: "unreadable", ino: st.ino, token: null };
      const buf = Buffer.alloc(Math.min(st.size || 0, LOCK_MAX_BYTES));
      if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, 0);
      const raw = buf.toString("utf-8");
      let body: any;
      try { body = JSON.parse(raw); } catch { return { state: "unreadable", ino: st.ino, token: null }; }
      if (!body || typeof body !== "object") return { state: "unreadable", ino: st.ino, token: null };
      if (!Number.isInteger(body.pid) || body.pid <= 0) return { state: "unreadable", ino: st.ino, token: null };
      if (typeof body.token !== "string" || body.token.length === 0) return { state: "unreadable", ino: st.ino, token: null };
      if (!Number.isFinite(body.acquiredAt) || body.acquiredAt <= 0) return { state: "unreadable", ino: st.ino, token: null };

      // EPERM means pid exists but we can't signal it — another uid owns it.
      // That cannot be our sidecar; treat as dead for staleness purposes to
      // avoid a PID-reuse wedge where the recorded pid was recycled to
      // another user and the lock becomes un-breakable until that process
      // exits. ESRCH is definitive dead.
      let owner: "alive" | "dead";
      try {
        process.kill(body.pid, 0);
        owner = "alive";
      } catch (e: any) {
        if (e && e.code === "ESRCH") owner = "dead";
        else if (e && e.code === "EPERM") owner = "dead";
        else owner = "alive";
      }
      const token: string = body.token;
      if (owner === "alive") return { state: "holder-alive", ino: st.ino, token };
      if (body.acquiredAt > Date.now()) return { state: "holder-grace", ino: st.ino, token }; // clock skew
      if (Date.now() - body.acquiredAt > STALENESS_FLOOR_MS) return { state: "holder-dead", ino: st.ino, token };
      return { state: "holder-grace", ino: st.ino, token };
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return { state: "unreadable", ino: null, token: null };
  }
}

export type UnlinkResult =
  | { unlinked: true }
  | { unlinked: false; reason: "foreign" | "symlink" | "error" | "raced" };

// Narrow the lstat/unlink TOCTOU window by holding an fd across the
// verification. When expectedInode/expectedToken are provided we require the
// currently-linked file to match before unlinking — this protects against a
// concurrent holder replacing the lock between inspect and unlink.
// expectedRenewedAt additionally fences against an IN-PLACE lease renewal by the
// SAME holder (same inode+token, newer renewedAt): a lease that looked stealable
// at inspect time is fresh again and must NOT be stolen. Exported for T-424
// (limit-lock reuses the verified-unlink primitive).
export function safeUnlinkLock(
  lockPath: string,
  expectedInode?: number | null,
  expectedToken?: string | null,
  expectedRenewedAt?: number | null,
): UnlinkResult {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e: any) {
    if (e && e.code === "ENOENT") return { unlinked: true };
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) {
      return { unlinked: false, reason: "symlink" };
    }
    livenessLog("safe-unlink-open-error", { code: e?.code, path: lockPath });
    return { unlinked: false, reason: "error" };
  }
  try {
    let st: fs.Stats;
    try { st = fs.fstatSync(fd); }
    catch (e: any) {
      livenessLog("safe-unlink-fstat-error", { code: e?.code });
      return { unlinked: false, reason: "error" };
    }
    if (!st.isFile()) return { unlinked: false, reason: "foreign" };
    const myUid = getOurUid();
    if (myUid >= 0 && st.uid !== myUid) return { unlinked: false, reason: "foreign" };
    if (expectedInode !== undefined && expectedInode !== null && st.ino !== expectedInode) {
      return { unlinked: false, reason: "raced" };
    }
    // Optional content re-verification: the caller observed `expectedToken`
    // in a prior inspect; if the current body parses as valid JSON with a
    // different token, a new holder has raced in and we must not unlink.
    //
    // An unparseable body is treated as corruption on OUR inode (we already
    // verified it above), not a race. The caller can still proceed to
    // unlink. This preserves the invariant that a valid, differently-owned
    // lock is never broken while letting us release corrupted bodies on
    // inodes we own.
    if ((expectedToken != null || expectedRenewedAt != null) && st.size <= LOCK_MAX_BYTES && st.size >= 0) {
      const buf = Buffer.alloc(Math.min(st.size || 0, LOCK_MAX_BYTES));
      let bodyParsed: any = null;
      let parseOk = false;
      try {
        if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, 0);
        bodyParsed = JSON.parse(buf.toString("utf-8"));
        parseOk = true;
      } catch { /* unparseable: treat as corruption on our inode */ }
      if (parseOk && bodyParsed && typeof bodyParsed === "object") {
        // A NEW holder raced in (different token) -> never unlink.
        if (expectedToken != null &&
            typeof bodyParsed.token === "string" &&
            bodyParsed.token !== expectedToken) {
          return { unlinked: false, reason: "raced" };
        }
        // The SAME holder renewed the lease in place (same token+inode, newer
        // renewedAt) after we inspected it as stealable -> the lock is fresh, so
        // stealing it would evict a live holder and violate singleton ownership.
        if (expectedRenewedAt != null &&
            typeof bodyParsed.renewedAt === "number" &&
            Number.isFinite(bodyParsed.renewedAt) &&
            bodyParsed.renewedAt !== expectedRenewedAt) {
          return { unlinked: false, reason: "raced" };
        }
      }
    }
    // Final lstat right before unlink to catch a path swap (unlink + link by
    // another process) between our fd-based verification and the unlink call.
    // Inode is still verified against our open fd's inode via st above.
    try {
      const lst = fs.lstatSync(lockPath);
      if (lst.isSymbolicLink()) return { unlinked: false, reason: "symlink" };
      if (lst.ino !== st.ino) return { unlinked: false, reason: "raced" };
    } catch (e: any) {
      if (e && e.code === "ENOENT") return { unlinked: true };
      livenessLog("safe-unlink-lstat-error", { code: e?.code });
      return { unlinked: false, reason: "error" };
    }
    try { fs.unlinkSync(lockPath); return { unlinked: true }; }
    catch (e: any) {
      if (e && e.code === "ENOENT") return { unlinked: true };
      livenessLog("safe-unlink-error", { code: e?.code, path: lockPath });
      return { unlinked: false, reason: "error" };
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function acquireSpawnLock(tDir: string): LockHandle | null {
  const token = randomBytes(16).toString("hex");
  const body: LockBody = { pid: process.pid, token, acquiredAt: Date.now() };
  const lockPath = join(tDir, LOCK_BASENAME);
  const tmpPath = join(tDir, `${LOCK_BASENAME}.tmp.${process.pid}.${Date.now()}.${randomHex4()}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
  } catch (e: any) {
    livenessLog("lock-tmp-write-failed", { code: e?.code });
    throw e;
  }
  let success = false;
  let foreignBreakCount = 0;
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ACQUIRE_DEADLINE_MS) {
      try {
        fsApi.linkSync(tmpPath, lockPath);
        const ino = safeStatIno(lockPath);
        success = true;
        return { token, lockPath, tmpPath, lockIno: ino };
      } catch (err: any) {
        const code = err?.code;
        if (code === "EEXIST") {
          const inspection = inspectExistingLock(lockPath);
          const { state, ino, token: observedToken } = inspection;
          if (state === "holder-alive" || state === "holder-grace") {
            sleepMs(ACQUIRE_POLL_MS);
            continue;
          }
          if (state === "holder-dead") {
            // Pass observed inode+token so safeUnlinkLock can abort if the
            // dead holder has been replaced between inspect and unlink.
            const r = safeUnlinkLock(lockPath, ino, observedToken);
            if (!r.unlinked) {
              // "raced" means a new holder appeared; treat as retry, not wedge.
              if (r.reason !== "raced") foreignBreakCount++;
              if (foreignBreakCount >= 2) {
                livenessLog("lock-foreign-wedged", { reason: r.reason });
                return null;
              }
              sleepMs(ACQUIRE_POLL_MS);
            }
            continue;
          }
          if (state === "unreadable") {
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(lockPath).mtimeMs; } catch { /* ignore */ }
            if (mtimeMs > 0 && Date.now() - mtimeMs > UNREADABLE_BREAK_MS) {
              // Unreadable lock has no token to verify; pass inode only.
              const r = safeUnlinkLock(lockPath, ino, null);
              if (!r.unlinked) {
                if (r.reason !== "raced") foreignBreakCount++;
                if (foreignBreakCount >= 2) {
                  livenessLog("lock-unreadable-wedged", { reason: r.reason });
                  return null;
                }
              }
              continue;
            }
            sleepMs(ACQUIRE_POLL_MS);
            continue;
          }
        }
        if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP" || code === "ENOSYS") {
          livenessLog("lock-unsupported-fs", { code });
          return null;
        }
        throw err;
      }
    }
    livenessLog("lock-acquire-timeout", {});
    return null;
  } finally {
    if (!success) {
      try { fs.unlinkSync(tmpPath); }
      catch (e: any) { if (e?.code !== "ENOENT") livenessLog("lock-tmp-unlink-failed", { code: e?.code }); }
    }
  }
}

function releaseSpawnLock(handle: LockHandle): void {
  // Inode + token verified unlink under a held fd. safeUnlinkLock:
  //   - refuses if inode diverges from handle.lockIno (swap by other holder)
  //   - refuses if body parses to a different token (another holder rewrote)
  //   - proceeds if body is unparseable on our inode (external corruption)
  safeUnlinkLock(handle.lockPath, handle.lockIno, handle.token);
  try { fs.unlinkSync(handle.tmpPath); }
  catch (e: any) { if (e?.code !== "ENOENT") livenessLog("release-tmp-unlink-failed", { code: e?.code }); }
}

function readSidecarPid(tDir: string): number | null {
  let fd: number;
  try { fd = fs.openSync(join(tDir, PID_BASENAME), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch { return null; }
  try {
    // Inner block swallows all errors so callers see a clean null-or-number
    // contract. Without this, fstatSync/readSync could throw on races
    // (truncation, file removed mid-read) and propagate to spawnAliveSidecar.
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return null;
      const myUid = getOurUid();
      if (myUid >= 0 && st.uid !== myUid) return null;
      if (st.size > SIDECAR_PID_MAX_BYTES || st.size < 0) return null;
      const buf = Buffer.alloc(Math.min(st.size || 0, SIDECAR_PID_MAX_BYTES));
      if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, 0);
      const raw = buf.toString("utf-8").trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return null;
      if (isSelfPid(n)) return null;
      return n;
    } catch (e: any) {
      livenessLog("read-sidecar-pid-error", { code: e?.code });
      return null;
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function writeSidecarPid(tDir: string, pid: number): void {
  const target = join(tDir, PID_BASENAME);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${randomHex4()}`;
  try {
    fs.writeFileSync(tmp, String(pid), { mode: 0o600 });
    fsApi.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function unlinkSidecarPid(tDir: string): void {
  try { fs.unlinkSync(join(tDir, PID_BASENAME)); }
  catch { /* may not exist */ }
}

function safetyCheck(pid: number): "already-dead" | "not-ours" | "proceed" {
  if (!Number.isInteger(pid) || pid <= 0) return "not-ours";
  if (isSelfPid(pid)) return "not-ours";
  try { process.kill(pid, 0); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return "already-dead";
    // EPERM / any other error: pid exists but is not ours to signal.
    return "not-ours";
  }
  if (!hasSidecarSignature(pid)) return "not-ours";
  return "proceed";
}

function escalate(
  pid: number,
  signal: NodeJS.Signals,
  hasSig: (p: number) => boolean = hasSidecarSignature,
): "exited" | "lost-signature" | "timeout" | "cannot-signal" {
  // Re-verify sidecar signature immediately before signaling to narrow the
  // PID-reuse TOCTOU between safetyCheck and this kill. If the pid was
  // recycled to an unrelated process after safetyCheck, abort rather than
  // risk signaling that process.
  if (!hasSig(pid)) return "lost-signature";
  try { process.kill(pid, signal); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return "exited";
    livenessLog("escalate-cannot-signal", { signal, code: e?.code });
    return "cannot-signal";
  }
  return waitForExit(pid, KILL_GRACE_MS, () => hasSig(pid));
}

function finalVerify(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (e: any) { if (e && e.code === "ESRCH") return true; /* EPERM: alive */ }
  return !hasSidecarSignature(pid);
}

function killJustSpawnedChild(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isSelfPid(pid)) return;
  try { process.kill(pid, "SIGTERM"); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return;
    livenessLog("orphan-kill-term-failed", { pid, code: e?.code });
  }
  const start = Date.now();
  while (Date.now() - start < KILL_GRACE_MS) {
    try { process.kill(pid, 0); }
    catch (e: any) { if (e && e.code === "ESRCH") return; }
    sleepMs(KILL_POLL_MS);
  }
  try { process.kill(pid, "SIGKILL"); }
  catch (e: any) {
    if (e && e.code === "ESRCH") return;
    livenessLog("orphan-kill-kill-failed", { pid, code: e?.code });
  }
}

function killPriorSidecarImpl(priorPid: number): boolean {
  const gate = safetyCheck(priorPid);
  if (gate !== "proceed") return true;
  const termResult = escalate(priorPid, "SIGTERM");
  if (termResult === "exited" || termResult === "lost-signature") return true;
  if (termResult === "cannot-signal") return false;
  if (!hasSidecarSignature(priorPid)) return true;
  const killResult = escalate(priorPid, "SIGKILL");
  if (killResult === "exited" || killResult === "lost-signature") return true;
  if (killResult === "cannot-signal") return false;
  return finalVerify(priorPid);
}

export function telemetryDirPath(sessionDir: string): string {
  return join(sessionDir, "telemetry");
}

export function spawnAliveSidecar(tDir: string, intervalMs = 10_000): number | null {
  try {
    fs.mkdirSync(tDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(tDir, 0o700); } catch { /* best-effort */ }
  } catch { /* best-effort */ }

  const handle = acquireSpawnLock(tDir);

  if (handle === null) {
    const existing = readSidecarPid(tDir);
    if (existing === null) return null;
    try { process.kill(existing, 0); } catch { return null; }
    if (!hasSidecarSignature(existing)) return null;
    return existing;
  }

  let spawnedPid: number | null = null;
  try {
    const priorPid = readSidecarPid(tDir);
    if (priorPid !== null) {
      let priorAliveWithSignature = false;
      try { process.kill(priorPid, 0); priorAliveWithSignature = hasSidecarSignature(priorPid); }
      catch { /* dead or unreachable */ }

      if (priorAliveWithSignature) {
        // Fail closed: only proceed if we can affirmatively confirm the prior
        // sidecar was spawned by us. A null ppid (ps/proc lookup transient
        // failure) is not evidence of ownership; killing would risk taking
        // down another session's sidecar.
        const priorPpid = getProcessPpid(priorPid);
        if (priorPpid !== process.pid) {
          livenessLog("prior-owned-by-other", { priorPid, priorPpid });
          return null;
        }
      }

      const killed = __testing.killPriorSidecar(priorPid);
      if (!killed) {
        livenessLog("kill-failed-abort", { priorPid });
        return null;
      }
    }

    try {
      fs.unlinkSync(join(tDir, "shutdown"));
    } catch (e: any) {
      if (e && e.code !== "ENOENT") {
        livenessLog("shutdown-unlink-failed", { code: e.code });
        return null;
      }
    }

    let child;
    try {
      child = spawn(
        process.execPath,
        ["-e", SIDECAR_SCRIPT, tDir, String(intervalMs), SIDECAR_ARGV_MARKER],
        { stdio: "ignore" }
      );
    } catch (e: any) {
      livenessLog("spawn-threw", { code: e?.code });
      return null;
    }
    child.unref();
    const newPid = child.pid ?? null;

    if (newPid !== null) {
      try {
        writeSidecarPid(tDir, newPid);
        spawnedPid = newPid;
      } catch (e: any) {
        livenessLog("write-pid-failed", { code: e?.code, newPid });
        // We just spawned this pid; bypass the signature gate (which races
        // the ps/proc table write for a freshly-forked child) and signal
        // it directly. SIGTERM, poll for exit, then SIGKILL if needed.
        killJustSpawnedChild(newPid);
        return null;
      }
    }
    return spawnedPid;
  } finally {
    releaseSpawnLock(handle);
  }
}

export function killSidecar(pid: number | undefined | null): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ESRCH or similar - process already dead
  }
}

export function writeShutdownMarker(sessionDir: string): void {
  const tDir = telemetryDirPath(sessionDir);
  try {
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(join(tDir, "shutdown"), "1");
    fs.writeFileSync(join(tDir, "alive"), "0");
    unlinkSidecarPid(tDir);
  } catch {
    // best-effort
  }
}

const _knownTelemetryDirs = new Set<string>();

export function touchLastMcpCallFile(sessionDir: string): void {
  const tDir = telemetryDirPath(sessionDir);
  const target = join(tDir, "lastMcpCall");
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    if (!_knownTelemetryDirs.has(tDir)) {
      fs.mkdirSync(tDir, { recursive: true });
      _knownTelemetryDirs.add(tDir);
    }
    fs.writeFileSync(tmp, new Date().toISOString());
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function readLastMcpCall(sessionDir: string): string | null {
  try {
    return (
      fs.readFileSync(join(telemetryDirPath(sessionDir), "lastMcpCall"), "utf-8").trim() || null
    );
  } catch {
    return null;
  }
}

export function readAliveTimestamp(sessionDir: string): number | null {
  const tDir = telemetryDirPath(sessionDir);
  if (fs.existsSync(join(tDir, "shutdown"))) return null;
  try {
    const val = fs.readFileSync(join(tDir, "alive"), "utf-8").trim();
    const n = Number(val);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function computeBinaryFingerprint(): {
  mtime: string;
  sha256: string;
} | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const parentDir = dirname(dirname(thisFile));
    const candidates = [
      join(parentDir, "mcp.js"),
      join(parentDir, "dist", "mcp.js"),
    ];
    for (const p of candidates) {
      try {
        const stat = fs.statSync(p);
        const buf = fs.readFileSync(p);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        return { mtime: stat.mtime.toISOString(), sha256 };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function captureClaudeCodeSessionId(): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID ?? null;
}

// Test-only export. Not part of the public API.
export const __testing = {
  hasSidecarSignature,
  inspectExistingLock,
  safeUnlinkLock,
  sleepMs,
  acquireSpawnLock,
  releaseSpawnLock,
  readSidecarPid,
  writeSidecarPid,
  killPriorSidecar: killPriorSidecarImpl,
  escalate,
  fsApi,
};
