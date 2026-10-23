/** Derived private observations. The retained trace, not this index, is authority. */
import { createHash } from "node:crypto";

const MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 16_384;
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
type Span = { start: number; end: number };
type Event = {
  ordinal: number;
  spans: Span[];
  kind: "syscall" | "unfinished" | "resumed" | "exit" | "signal" | "unknown";
  pid?: number;
  reportedTime?: string;
  operation?: string;
  family?: "process" | "file" | "memoryMap" | "privilege" | "network" | "other";
  returnToken?: string;
  pairedOrdinal?: number;
};
const families = {
  process: new Set([
    "execve",
    "execveat",
    "fork",
    "vfork",
    "clone",
    "clone3",
    "exit",
    "exit_group",
    "wait4",
    "waitid",
  ]),
  file: new Set([
    "open",
    "openat",
    "openat2",
    "close",
    "read",
    "pread64",
    "readv",
    "write",
    "pwrite64",
    "writev",
    "rename",
    "renameat",
    "renameat2",
    "unlink",
    "unlinkat",
    "getdents",
    "getdents64",
    "stat",
    "lstat",
    "fstat",
    "newfstatat",
    "statx",
    "readlink",
    "readlinkat",
    "mkdir",
    "mkdirat",
    "link",
    "linkat",
    "symlink",
    "symlinkat",
    "truncate",
    "ftruncate",
    "chdir",
    "fchdir",
  ]),
  memoryMap: new Set([
    "mmap",
    "mmap2",
    "munmap",
    "mprotect",
    "pkey_mprotect",
    "mremap",
  ]),
  privilege: new Set([
    "setuid",
    "setgid",
    "setreuid",
    "setregid",
    "setresuid",
    "setresgid",
    "setgroups",
    "capset",
    "prctl",
    "seccomp",
    "unshare",
    "setns",
    "mount",
    "umount2",
    "ptrace",
  ]),
  network: new Set([
    "socket",
    "socketpair",
    "connect",
    "bind",
    "listen",
    "accept",
    "accept4",
    "sendto",
    "recvfrom",
    "sendmsg",
    "recvmsg",
    "sendmmsg",
    "recvmmsg",
    "getsockname",
    "getpeername",
    "setsockopt",
    "getsockopt",
    "shutdown",
  ]),
};

function family(name: string): NonNullable<Event["family"]> {
  for (const [key, names] of Object.entries(families))
    if (names.has(name)) return key as NonNullable<Event["family"]>;
  return "other";
}

/**
 * Index the pinned strace -f -ttt text without interpreting argument strings.
 * Byte order is preserved; reported wall times do not establish causal order.
 */
export function indexSyscalls(
  raw: Uint8Array,
  context: {
    expectedSha256: string;
    collectorExitCode: number;
    collectorTermination: string;
    vmTermination: string;
  },
) {
  if (raw.length > MAX_BYTES || hash(raw) !== context.expectedSha256)
    throw new Error("Trace is oversized or differs from its retained digest");
  const visibility = new Set([
    "derived-index-is-not-independent-kernel-evidence",
    "kernel-event-loss-cannot-be-measured-from-strace-text",
    "syscall-arguments-and-return-values-are-untrusted-observations",
    "syscall-string-values-bounded-to-256-bytes",
    "reported-timestamps-do-not-prove-causal-order",
    "executed-binary-digests-not-established-by-paths",
    "dns-http-and-complete-runtime-coverage-not-established",
  ]);
  if (!raw.length) visibility.add("empty-trace");
  if (raw.length >= MAX_BYTES) visibility.add("trace-byte-limit-reached");
  if (
    context.collectorExitCode !== 0 ||
    context.collectorTermination !== "command-exit"
  )
    visibility.add("collector-did-not-complete");
  if (context.vmTermination !== "guest-exit")
    visibility.add("vm-did-not-exit-normally");
  const events: Event[] = [];
  const pending = new Map<number, Event>();
  const pids = new Set<number>();
  const exited = new Set<number>();
  const childObservations: {
    callerPid: number;
    returnedId: number;
    operation: string;
    eventOrdinal: number;
  }[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = 0;
  let indexedBytes = 0;
  let priorTime: string | undefined;
  while (cursor < raw.length) {
    if (events.length === MAX_EVENTS) {
      visibility.add("event-index-limit-unindexed-tail");
      break;
    }
    const start = cursor;
    while (cursor < raw.length && raw[cursor] !== 10) cursor++;
    const hasNewline = cursor < raw.length;
    const textEnd = cursor;
    if (hasNewline) cursor++;
    else visibility.add("unterminated-final-line");
    const event: Event = {
      ordinal: events.length,
      spans: [{ start, end: cursor }],
      kind: "unknown",
    };
    events.push(event);
    indexedBytes = cursor;
    let text: string;
    try {
      text = decoder.decode(raw.subarray(start, textEnd));
    } catch {
      visibility.add("invalid-utf8-line");
      continue;
    }
    const prefix = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/u.exec(text);
    if (!prefix || !Number.isSafeInteger(Number(prefix[1]))) {
      visibility.add("unrecognized-trace-line");
      continue;
    }
    const pid = Number(prefix[1]);
    event.pid = pid;
    event.reportedTime = prefix[2];
    // Compare decimal timestamps exactly, without float rounding.
    const sortableTime = prefix[2]
      .split(".")
      .map((part, index) =>
        index ? part.padEnd(12, "0") : part.padStart(20, "0"),
      )
      .join(".");
    if (priorTime && sortableTime < priorTime)
      visibility.add("reported-time-reversal");
    priorTime = sortableTime;
    pids.add(pid);
    if (exited.has(pid)) visibility.add("pid-reappeared-after-observed-exit");
    const body = prefix[3];
    if (
      /^\+\+\+ (?:exited with \d+|killed by SIG[A-Z0-9]+(?: \(core dumped\))?) \+\+\+$/u.test(
        body,
      )
    ) {
      event.kind = "exit";
      exited.add(pid);
      if (pending.has(pid))
        visibility.add("process-exited-with-unfinished-call");
      continue;
    }
    if (/^--- SIG[A-Z0-9]+ .* ---$/u.test(body)) {
      event.kind = "signal";
      continue;
    }
    const resumed = /^<\.\.\. ([a-zA-Z0-9_]+) resumed>/u.exec(body);
    const started = /^([a-zA-Z0-9_]+)\(/u.exec(body);
    const operation = resumed?.[1] ?? started?.[1];
    if (!operation) {
      visibility.add("unrecognized-trace-line");
      continue;
    }
    event.operation = operation;
    event.family = family(operation);
    if (event.family === "other")
      visibility.add("unclassified-syscall-semantics");
    if (body.includes("..."))
      visibility.add("abbreviated-or-split-syscall-text");
    if (resumed) {
      event.kind = "resumed";
      const previous = pending.get(pid);
      if (!previous || previous.operation !== operation) {
        visibility.add("unmatched-resumed-call");
      } else {
        event.pairedOrdinal = previous.ordinal;
        previous.pairedOrdinal = event.ordinal;
      }
      pending.delete(pid);
    } else if (body.endsWith("<unfinished ...>")) {
      event.kind = "unfinished";
      if (pending.has(pid)) visibility.add("overlapping-unfinished-call");
      pending.set(pid, event);
      continue;
    } else {
      event.kind = "syscall";
      if (pending.has(pid)) visibility.add("call-arrived-before-resume");
    }
    const result = /\) = (-?\d+|0x[0-9a-fA-F]+|\?)(?:\s|$)/u.exec(
      body.slice(body.lastIndexOf(") = ")),
    );
    if (!result) {
      visibility.add("unrecognized-syscall-return");
      continue;
    }
    event.returnToken = result[1];
    if (
      ["clone", "clone3", "fork", "vfork"].includes(operation) &&
      (!resumed || event.pairedOrdinal !== undefined) &&
      /^[1-9]\d*$/u.test(result[1]) &&
      Number.isSafeInteger(Number(result[1]))
    ) {
      childObservations.push({
        callerPid: pid,
        returnedId: Number(result[1]),
        operation,
        eventOrdinal: event.ordinal,
      });
    }
  }
  if (pending.size) visibility.add("unfinished-calls-at-end-of-capture");
  if ([...pids].some((pid) => !exited.has(pid)))
    visibility.add("process-lifetimes-not-fully-observed");
  const coverage = Object.fromEntries(
    ["process", "file", "memoryMap", "privilege", "network"].map((name) => [
      name,
      events.some((event) => event.family === name) ? "partial" : "missing",
    ]),
  );
  return {
    schema: "slop-syscall-index-v1",
    parserRevision: "strace-text-v1",
    state: "incomplete",
    rawSha256: context.expectedSha256,
    rawBytes: raw.length,
    indexedBytes,
    eventLimit: MAX_EVENTS,
    context,
    events,
    childObservations,
    observedPids: [...pids].sort((a, b) => a - b),
    coverage: {
      ...coverage,
      blockDevice: "missing",
      dynamicLoading: "missing",
      dns: "missing",
      http: "missing",
      artifactDiff: "missing",
      canary: "missing",
    },
    visibilityGaps: [...visibility].sort(),
    kernelLostEventCount: null,
    providerCallsAuthorized: false,
    publicationAuthorized: false,
  } as const;
}

/** Keep full derived bytes privately; bound the additional model input explicitly. */
export function syscallEvidence(index: ReturnType<typeof indexSyscalls>) {
  const bytes = Buffer.from(JSON.stringify(index));
  if (bytes.length > 8 * 1024 * 1024)
    throw new Error("Structured trace index exceeds private evidence bound");
  const indexSha256 = hash(bytes);
  const operations: Record<string, number> = Object.create(null);
  let uncountedOperationNames = 0;
  for (const event of index.events) {
    if (!event.operation) continue;
    if (
      event.operation.length > 64 ||
      (!(event.operation in operations) &&
        Object.keys(operations).length >= 256)
    ) {
      uncountedOperationNames++;
      continue;
    }
    operations[event.operation] = (operations[event.operation] ?? 0) + 1;
  }
  const summary = {
    schema: "slop-syscall-review-v1",
    state: "incomplete",
    indexSha256,
    indexBytes: bytes.length,
    rawSha256: index.rawSha256,
    rawBytes: index.rawBytes,
    indexedBytes: index.indexedBytes,
    totalEvents: index.events.length,
    observedPidCount: index.observedPids.length,
    childObservationCount: index.childObservations.length,
    operations,
    uncountedOperationNames,
    selection: "first events in retained byte order; at most 128",
    events: [] as Event[],
    omittedEvents: index.events.length,
    coverage: index.coverage,
    visibilityGaps: [...index.visibilityGaps],
    kernelLostEventCount: null,
    providerCallsAuthorized: false,
    publicationAuthorized: false,
  };
  // Reserve space for final omission counters and gap labels.
  for (const event of index.events.slice(0, 128)) {
    summary.events.push(event);
    if (Buffer.byteLength(JSON.stringify(summary)) > 64 * 1024 - 512) {
      summary.events.pop();
      break;
    }
  }
  summary.omittedEvents = index.events.length - summary.events.length;
  if (summary.omittedEvents || uncountedOperationNames)
    summary.visibilityGaps.push("structured-index-not-fully-in-model-review");
  const review = Buffer.from(JSON.stringify(summary));
  if (review.length > 64 * 1024)
    throw new Error("Structured trace review exceeds its input bound");
  return { bytes, indexSha256, review };
}
