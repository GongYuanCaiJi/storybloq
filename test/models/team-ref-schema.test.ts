import { describe, it, expect } from "vitest";
import {
  TicketRefSchema,
  IssueRefSchema,
  NoteRefSchema,
  LessonRefSchema,
} from "../../src/models/types.js";

describe("TicketRefSchema", () => {
  it("accepts legacy T-001", () => {
    expect(TicketRefSchema.safeParse("T-001").success).toBe(true);
  });

  it("accepts legacy with suffix T-077a", () => {
    expect(TicketRefSchema.safeParse("T-077a").success).toBe(true);
  });

  it("accepts canonical t-[crockford16]", () => {
    expect(TicketRefSchema.safeParse("t-k7m2p9x3w4a5b6e8").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(TicketRefSchema.safeParse("").success).toBe(false);
  });

  it("rejects cross-entity ISS-001", () => {
    expect(TicketRefSchema.safeParse("ISS-001").success).toBe(false);
  });

  it("rejects invalid format", () => {
    expect(TicketRefSchema.safeParse("not-valid").success).toBe(false);
  });

  it("is case-sensitive (rejects lowercase legacy)", () => {
    expect(TicketRefSchema.safeParse("t-001").success).toBe(false);
  });

  it("is case-sensitive (rejects uppercase canonical)", () => {
    expect(TicketRefSchema.safeParse("T-K7M2P9X3W4A5B6E8").success).toBe(false);
  });
});

describe("IssueRefSchema", () => {
  it("accepts legacy ISS-001", () => {
    expect(IssueRefSchema.safeParse("ISS-001").success).toBe(true);
  });

  it("accepts canonical i-[crockford16]", () => {
    expect(IssueRefSchema.safeParse("i-k7m2p9x3w4a5b6e8").success).toBe(true);
  });

  it("rejects cross-entity T-001", () => {
    expect(IssueRefSchema.safeParse("T-001").success).toBe(false);
  });
});

describe("NoteRefSchema", () => {
  it("accepts legacy N-001", () => {
    expect(NoteRefSchema.safeParse("N-001").success).toBe(true);
  });

  it("accepts canonical n-[crockford16]", () => {
    expect(NoteRefSchema.safeParse("n-k7m2p9x3w4a5b6e8").success).toBe(true);
  });

  it("rejects cross-entity T-001", () => {
    expect(NoteRefSchema.safeParse("T-001").success).toBe(false);
  });
});

describe("LessonRefSchema", () => {
  it("accepts legacy L-001", () => {
    expect(LessonRefSchema.safeParse("L-001").success).toBe(true);
  });

  it("accepts canonical l-[crockford16]", () => {
    expect(LessonRefSchema.safeParse("l-k7m2p9x3w4a5b6e8").success).toBe(true);
  });

  it("rejects cross-entity T-001", () => {
    expect(LessonRefSchema.safeParse("T-001").success).toBe(false);
  });
});
