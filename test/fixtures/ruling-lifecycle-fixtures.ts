/** T-522 plan section 1: the concrete fixtures, verbatim, shared by the model and core tests. */
const recordedBy = { client: "claude", id: "aaa3eb21" };

export const FIXTURE_A = {
  id: "r-2222222222222222",
  text: "Background work carries the request id of the job that enqueued it",
  attribution: "owner-direct",
  recordedBy,
  date: "2026-09-21",
  scopeTags: ["logging"],
  supersedes: null,
  createdAt: "2026-09-21T10:00:00.000Z",
  status: "proposed",
  proposesToSupersede: "r-1111111111111111",
  proposedFor: ["T-2"],
  narrative: { context: "Jobs lose the request id at the queue boundary" },
} as const;

export const DIGEST_B = "4bec1d4e9bfde185f9d44c0ec04c96d91745bfb38d419cd012c213f98359b2e1";
export const DIGEST_D = "2c476104e5bbd5fbd8665b296dcfaa3156ade33cb732ac0ec0c3f2a2a5d43c31";
export const DIGEST_F = "3ce6d03b86859e7dcce4b7ad1226ca8f349765c67997ffff2b4cf0491940fb32";

export const FIXTURE_B = {
  ...FIXTURE_A,
  supersedes: "r-1111111111111111",
  status: "accepted",
  acceptance: {
    attribution: "owner-direct",
    recordedBy,
    date: "2026-09-22",
    createdAt: "2026-09-22T09:00:00.000Z",
    payloadDigest: DIGEST_B,
  },
} as const;

/** The exact 1.15 shape, key order as the CLI wrote it. */
export const FIXTURE_C = {
  attribution: "owner-direct",
  createdAt: "2026-09-06T18:12:00.000Z",
  date: "2026-09-06",
  id: "r-1111111111111111",
  recordedBy: { client: "claude", id: "6bd82ca1" },
  scopeTags: ["logging"],
  supersedes: null,
  text: "Logging keeps redaction and request ids on every path",
} as const;

export const FIXTURE_D = {
  id: "r-3333333333333333",
  text: "Redaction is never skipped",
  attribution: "owner-direct",
  recordedBy,
  date: "2026-09-21",
  scopeTags: ["logging"],
  supersedes: null,
  createdAt: "2026-09-21T11:00:00.000Z",
  status: "accepted",
  proposesToSupersede: null,
  proposedFor: [],
  narrative: { consequences: "Debug builds log redacted values too" },
  acceptance: {
    attribution: "owner-direct",
    recordedBy,
    date: "2026-09-21",
    createdAt: "2026-09-21T11:00:00.000Z",
    payloadDigest: DIGEST_D,
  },
} as const;

export const FIXTURE_E = {
  id: "r-4444444444444444",
  text: "Redaction may be skipped in debug builds",
  attribution: "owner-direct",
  recordedBy,
  date: "2026-09-21",
  scopeTags: ["logging"],
  supersedes: null,
  createdAt: "2026-09-21T10:30:00.000Z",
  status: "withdrawn",
  proposesToSupersede: "r-1111111111111111",
  proposedFor: ["T-2"],
  withdrawal: {
    recordedBy,
    createdAt: "2026-09-21T12:00:00.000Z",
    reason: "superseded by the owner's direct ruling r-3333333333333333",
  },
} as const;

export const FIXTURE_F = {
  id: "r-5555555555555555",
  text: "Logging keeps redaction and request ids on every path, including background jobs",
  attribution: "owner-direct",
  recordedBy,
  date: "2026-09-23",
  scopeTags: ["logging"],
  supersedes: "r-1111111111111111",
  createdAt: "2026-09-23T08:00:00.000Z",
  status: "accepted",
  proposesToSupersede: "r-1111111111111111",
  proposedFor: [],
  acceptance: {
    attribution: "owner-direct",
    recordedBy,
    date: "2026-09-23",
    createdAt: "2026-09-23T08:00:00.000Z",
    payloadDigest: DIGEST_F,
  },
} as const;
