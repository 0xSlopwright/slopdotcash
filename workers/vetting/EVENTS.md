# Private syscall observations

PRD VET-03 and MVP-12 require structured runtime evidence. `events.ts` indexes
the retained `strace -f -ttt -yy -s 256` output. It does not run project code,
authorize a provider call, or change scan clearance.

Each event records its ordinal and exact byte range in the SHA-256-bound raw
trace. The end offset is exclusive and includes the line terminator when one
exists. Raw byte order is retained. A reported timestamp is guest data, not
proof of clock accuracy or causal order. An unfinished call and its resumed
line remain separate events with reciprocal ordinal references.

The index records syscall names and return tokens. It does not interpret
argument strings, resolve paths, infer binary digests, or assert that a returned
child ID identifies a process rather than a thread. Child observations require
an observed successful fork or clone return; an unmatched resumed line cannot
create that observation. Raw unknown lines remain addressable by byte range.

Observed syscall families have partial coverage. Unobserved families have
missing coverage. Device access, dynamic loading, DNS, HTTP, canary behavior and
filesystem diffs cannot be established by syscall names alone. The index does
not replace their separate evidence. Unknown syntax, unfinished calls, missing
process exits, collector termination, malformed text and limits add gaps.
Kernel event loss remains unknown even if every retained line parses.

## Bounds and retention

The parser checks the exact raw digest and accepts at most 1 MiB. It indexes
at most 16,384 lines. If that limit is reached, `indexedBytes` identifies the
unindexed tail and a gap remains. The complete original trace is retained
separately.

The private derived index has an 8 MiB bound. A separate model-facing summary
has a 64 KiB bound and binds the private index digest and size. It includes
bounded operation counts and the first at most 128 events in raw byte order.
Omitted events or operation names add an explicit review gap. Failure to fit
an evidence bound is an error, not a clean or complete result. Neither output
authorizes publication or provider calls.

The existing `scripts/vetting-assembly-workflow.ts` checks real retained guest
traces, split calls, raw spans, digest refusal, truncated and malformed copies,
and a dense copy made from an actually observed line. Replayed trace checks
are not evidence of a new VM run or independent host collection.

The canonical assembler derives the index after checking the trace against the
actual guest serial frame and receipt. It saves `syscall-index.json` privately,
binds its exact bytes in the assembly manifest, and includes the bounded review
summary alongside the complete raw trace. Every summary gap also appears in the
assembly. Storage closure requires both derived objects and their exact raw-trace
binding. Removing the full index cannot leave a retained-summary claim.
