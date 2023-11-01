import { runCommand } from "./utils";

export interface VexcodeCommandFeedback {
  command: string;
  details: string;
  json: string;
  statusCode: number;
}

export function isVexcodeCommandFeedback(obj: unknown): obj is VexcodeCommandFeedback {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const feedback = obj as VexcodeCommandFeedback;

  return (
    typeof feedback.command === "string" &&
    typeof feedback.details === "string" &&
    typeof feedback.json === "string" &&
    typeof feedback.statusCode === "number"
  );
}

export async function isVexProductConnected(): Promise<boolean> {
  const result = await runCommand("vexrobotics.vexcode.system.info");
  return result[0] && isVexcodeCommandFeedback(result[1]) && result[1].json !== "{}";
}

