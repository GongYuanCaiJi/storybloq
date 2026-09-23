/**
 * Stage registration -- imports all stage implementations and registers them.
 * Import this module once (in guide.ts) to populate the registry.
 */
import { registerStage } from "./registry.js";
import { PickTicketStage } from "./pick-ticket.js";
import { PlanStage } from "./plan.js";
import { PlanReviewStage } from "./plan-review.js";
import { ImplementStage } from "./implement.js";
import { WriteTestsStage } from "./write-tests.js";
import { TestStage } from "./test.js";
import { CodeReviewStage } from "./code-review.js";
import { BuildStage } from "./build.js";
import { VerifyStage } from "./verify.js";
import { FinalizeStage } from "./finalize.js";
import { KnowledgeReviewStage } from "./knowledge-review.js";
import { CompleteStage } from "./complete.js";
import { LessonCaptureStage } from "./lesson-capture.js";
import { IssueFixStage } from "./issue-fix.js";
import { IssueSweepStage } from "./issue-sweep.js";
import { HandoverStage } from "./handover.js";

// Register all extracted stages (pipeline order)
registerStage(new PickTicketStage());
registerStage(new PlanStage());
registerStage(new PlanReviewStage());
registerStage(new ImplementStage());
registerStage(new WriteTestsStage());
registerStage(new TestStage());
registerStage(new CodeReviewStage());
registerStage(new BuildStage());
registerStage(new VerifyStage());
registerStage(new FinalizeStage());
// T-527: not in any recipe's pipeline; reached only by goto from FINALIZE or COMPLETE.
registerStage(new KnowledgeReviewStage());
registerStage(new CompleteStage());
registerStage(new LessonCaptureStage());
registerStage(new IssueFixStage());
registerStage(new IssueSweepStage());
registerStage(new HandoverStage());
