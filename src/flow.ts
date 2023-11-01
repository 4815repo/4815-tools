import * as vscode from "vscode";
import { Progress, ProgressCancelError } from "./ui/progress";
import { runCommand, delay, fail, success } from "./utils";
import { isVexcodeCommandFeedback, isVexProductConnected } from "./vex";

export async function buildProject(type: "build" | "rebuild"): Promise<boolean> {
  const result = await runCommand("vexrobotics.vexcode.project." + type);
  return result[0] && result[1] === 0;
}

export async function downloadProgram(): Promise<boolean> {
  const result = await runCommand("vexrobotics.vexcode.system.download");
  return result[0] && isVexcodeCommandFeedback(result[1]) && result[1].statusCode === 0;
}

export async function runFlow(type: "build" | "rebuild"): Promise<boolean> {
  try {
    using progress = new Progress(vscode.l10n.t("Flow"));
    await progress.init();

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(20, vscode.l10n.t("Building"));

    const buildResult = await buildProject(type);
    if (!buildResult) {
      return fail(vscode.l10n.t("Build failed"));
    }

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(40);

    let waitingForBrainAttempt = 0;
    while (true) {
      const startTimestamp = Date.now();
      if (await isVexProductConnected()) break;
      const endTimestamp = Date.now();

      progress.set(undefined, vscode.l10n.t("Waiting for VEX product... ({0} attempts)", ++waitingForBrainAttempt));

      await delay(Math.max(0, 200 - (endTimestamp - startTimestamp)));
    }

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(60, vscode.l10n.t("Starting to upload"));

    for (let i = 0; i < 3; i++) {
      if (i !== 0) {
        progress.set(70, vscode.l10n.t("Upload failed, retrying... ({0}/2)", i + 1));
      }

      if (await downloadProgram()) {
        return success(vscode.l10n.t("Flow done"));
      }
    }

    return fail(vscode.l10n.t("Upload failed"));
  } catch (e) {
    if (e instanceof ProgressCancelError) 0; // noop
    else throw e;

    return false;
  }
}
