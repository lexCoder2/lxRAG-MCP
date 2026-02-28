/**
 * Command execution utilities with timeout and output size limits
 * Phase 4: Security hardening
 */

import { execSync } from "child_process";
import type { ExecSyncOptionsWithStringEncoding } from "child_process";
import * as env from "../env.js";

export interface SafeExecOptions extends Omit<ExecSyncOptionsWithStringEncoding, "encoding"> {
  timeout?: number;
  maxOutputBytes?: number;
  encoding?: "utf-8";
}

/**
 * Execute a command with timeout and output size limits
 * @param command Command to execute
 * @param options Execution options (timeout, maxOutputBytes, etc)
 * @returns Command output
 * @throws Error if timeout exceeded or output exceeds limit
 */
export function execWithTimeout(command: string, options: SafeExecOptions = {}): string {
  const {
    timeout = env.LXDIG_COMMAND_EXECUTION_TIMEOUT_MS,
    maxOutputBytes = env.LXDIG_COMMAND_OUTPUT_SIZE_LIMIT_BYTES,
    encoding = "utf-8",
    ...execOptions
  } = options;

  try {
    const output = execSync(command, {
      ...execOptions,
      encoding,
      timeout,
      maxBuffer: maxOutputBytes,
    }) as string;

    return output;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("ETIMEDOUT")) {
        throw new Error(
          `Command execution timeout exceeded (${timeout}ms): ${command.substring(0, 100)}`,
          { cause: error },
        );
      }
      if (error.message.includes("maxBuffer")) {
        throw new Error(
          `Command output exceeded size limit (${maxOutputBytes} bytes): ${command.substring(0, 100)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

/**
 * Execute a command with timeout, catching all errors
 * @param command Command to execute
 * @param options Execution options
 * @returns [success, output, error]
 */
export function execWithTimeoutSafe(
  command: string,
  options: SafeExecOptions = {},
): [success: boolean, output: string, error: string | null] {
  try {
    const output = execWithTimeout(command, options);
    return [true, output, null];
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return [false, "", errorMsg];
  }
}
