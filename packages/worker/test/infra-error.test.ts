import { describe, expect, it } from "vitest";
import { infraError } from "../src/infra-error";
describe("full infrastructure error evidence",()=>{
  it("retains the complete reset reason, stack and flags while removing credentials",()=>{
    const cause=new Error("storage operation exceeded timeout; " + "x".repeat(400));
    const error=Object.assign(new Error("Durable Object reset: bkw_private Bearer private bridge_session=session; ?token=hidden",{cause}),{overloaded:true,retryable:true});
    const result=infraError(error), text=JSON.stringify(result);
    expect(result.overloaded).toBe(true);expect(result.retryable).toBe(true);
    expect(text).toContain("storage operation exceeded timeout");expect(text).toContain("x".repeat(400));expect(result.stack).toBeTruthy();
    expect(text).not.toMatch(/bkw_private|Bearer private|=session|=hidden/);
    expect(JSON.stringify(infraError(new Error("opaque-credential"),["opaque-credential"]))).not.toContain("opaque-credential");
  });
});
