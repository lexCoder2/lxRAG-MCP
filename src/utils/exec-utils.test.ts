import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
import { execWithTimeout, execWithTimeoutSafe } from "./exec-utils.js";

describe("exec-utils", () => {
  const mockedExecSync = vi.mocked(execSync);

  afterEach(() => {
    mockedExecSync.mockReset();
  });

  it("execWithTimeout returns command output", () => {
    mockedExecSync.mockReturnValue("ok\n" as any);

    const output = execWithTimeout("echo ok", {
      timeout: 1234,
      maxOutputBytes: 99,
    });

    expect(output).toBe("ok\n");
    expect(mockedExecSync).toHaveBeenCalledWith(
      "echo ok",
      expect.objectContaining({
        timeout: 1234,
        maxBuffer: 99,
        encoding: "utf-8",
      }),
    );
  });

  it("execWithTimeout maps ETIMEDOUT errors to friendly message", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("spawnSync /bin/sh ETIMEDOUT");
    });

    expect(() => execWithTimeout("sleep 10", { timeout: 1 })).toThrow(
      "Command execution timeout exceeded",
    );
  });

  it("execWithTimeout maps maxBuffer errors to friendly message", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("stdout maxBuffer length exceeded");
    });

    expect(() =>
      execWithTimeout("cat big.txt", { maxOutputBytes: 10 }),
    ).toThrow("Command output exceeded size limit");
  });

  it("execWithTimeoutSafe returns success tuple on success", () => {
    mockedExecSync.mockReturnValue("done" as any);

    const [success, output, error] = execWithTimeoutSafe("echo done");

    expect(success).toBe(true);
    expect(output).toBe("done");
    expect(error).toBeNull();
  });

  it("execWithTimeoutSafe returns error tuple on failure", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("boom");
    });

    const [success, output, error] = execWithTimeoutSafe("bad");

    expect(success).toBe(false);
    expect(output).toBe("");
    expect(error).toContain("boom");
  });
});
