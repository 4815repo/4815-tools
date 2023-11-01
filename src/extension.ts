import * as vscode from "vscode";
import { UserInfo, userInfo } from "os";
import { API as GitAPI, GitExtension, RefType, Repository } from "./typings/git";
import { Progress, ProgressCancelError } from "./ui/progress";
import path = require("path");
import {
  success,
  isDescendant,
  makeDir,
  fail,
  runCommand,
  pathEquals,
  timeSince,
  getDateString,
  stat,
  getProjectSlugFromName,
  getCompetitionSessionYearString,
  getTemplateNamePrefix
} from "./utils";
import { runFlow } from "./flow";
import {
  BitbucketRepository,
  createRepository,
  getBitbucketProjectKey,
  getBitbucketUser,
  getBitbucketWorkspace,
  getRepositoriesWithUserConfig,
  getRepositoryUrl
} from "./bitbucket";
import { MultiStepInput, QuickPickParameters } from "./ui/multiStepInput";

export function getGitAPI(): GitAPI {
  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
  if (!gitExtension)
    throw new Error(vscode.l10n.t("Git support is not available at this time. Please check your setup and try again."));

  return gitExtension.getAPI(1);
}

export function getConfig(): vscode.WorkspaceConfiguration {
  return extensionConfig || vscode.workspace.getConfiguration("4815-tools");
}

export function getConfigValue<T>(key: string): T {
  const value = getConfig().get<T>(key);
  if (value === undefined) throw new Error(vscode.l10n.t("Configuration {0} is not defined", key));
  return value;
}

export function getProjectHome(): string {
  return getConfigValue<string>("projects.projectHome");
}

export function getTemplateHome(): string {
  return getConfigValue<string>("projects.templateHome");
}

export function getMainTemplateRepo(): string {
  return getConfigValue<string>("projects.mainTemplateRepo");
}

export function getIsAddPrefixToNewRepo(): boolean {
  return getConfigValue<boolean>("projects.addPrefixToNewRepo");
}

export function getSecrets(): vscode.SecretStorage | undefined {
  return extensionContext?.secrets;
}

export async function selectBitbucketRepository(
  repos: BitbucketRepository[],
  title: string,
  onShow?: (input: vscode.QuickPick<vscode.QuickPickItem>) => void
): Promise<(vscode.QuickPickItem & { repository: BitbucketRepository }) | null> {
  type BitbucketRepositoryQuickPickItem = vscode.QuickPickItem & { repository: BitbucketRepository };

  const items = repos.map<BitbucketRepositoryQuickPickItem>(repo => ({
    label: repo.name,
    description: repo.slug,
    detail: vscode.l10n.t(
      "Last updated {0} ago on {1}",
      timeSince(new Date(repo.updated_on)),
      getDateString(new Date(repo.updated_on))
    ),
    repository: repo
  }));

  const disposables: vscode.Disposable[] = [];
  try {
    return await new Promise<BitbucketRepositoryQuickPickItem | null>((resolve, reject) => {
      const input = vscode.window.createQuickPick<BitbucketRepositoryQuickPickItem>();
      input.title = title;
      input.ignoreFocusOut = true;
      input.placeholder = vscode.l10n.t("Type to search");
      input.items = items;
      disposables.push(
        input,
        input.onDidChangeSelection(items => resolve(items[0])),
        input.onDidHide(() => resolve(null))
      );
      input.show();

      onShow?.(input);
    });
  } finally {
    disposables.forEach(d => d.dispose());
  }
}

export async function setupRepositoryConfiguration(repo: Repository): Promise<boolean> {
  await repo.setConfig("user.name", getConfigValue<string>("remote.bitbucket.machineName"));
  await repo.setConfig("user.email", getConfigValue<string>("remote.bitbucket.email"));
  await repo.setConfig("commit.gpgsign", "false");
  return true;
}

export async function backupChanges(): Promise<boolean> {
  const api = getGitAPI();

  const active = vscode.window.activeTextEditor;
  const repo = active ? api.getRepository(active.document.uri) : await pickRepository();
  if (!repo) return false; // TODO

  const allUnsavedRepoDocuments = vscode.workspace.textDocuments.filter(
    d => !d.isUntitled && d.isDirty && isDescendant(repo.rootUri.fsPath, d.uri.fsPath)
  );

  if (allUnsavedRepoDocuments.length > 0) {
    const message =
      allUnsavedRepoDocuments.length === 1
        ? vscode.l10n.t(
            "The following file has unsaved changes which won't be included in the commit if you proceed: {0}.\n\nWould you like to save it before committing?",
            path.basename(allUnsavedRepoDocuments[0].uri.fsPath)
          )
        : vscode.l10n.t(
            "There are {0} unsaved files.\n\nWould you like to save them before committing?",
            allUnsavedRepoDocuments.length
          );
    const saveAndCommit = vscode.l10n.t("Save All & Commit Changes");
    const commit = vscode.l10n.t("Commit Changes");
    const pick = await vscode.window.showWarningMessage(message, { modal: true }, saveAndCommit, commit);

    if (pick === saveAndCommit) {
      await Promise.all(allUnsavedRepoDocuments.map(d => d.save()));

      // After saving the dirty documents, if there are any documents that are part of the
      // index group we have to add them back in order for the saved changes to be committed
      const allAddBacks = allUnsavedRepoDocuments.filter(d =>
        repo.state.indexChanges.some(s => pathEquals(s.uri.fsPath, d.uri.fsPath))
      );
      await repo.add(allAddBacks.map(d => d.uri.fsPath));
    } else if (pick !== commit) {
      return false; // do not commit on cancel
    }
  }

  try {
    using progress = new Progress(vscode.l10n.t("Backup"));
    await progress.init();

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(20, vscode.l10n.t("Setting up repository configuration"));
    await setupRepositoryConfiguration(repo);

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    if (repo.state.indexChanges.length === 0 && repo.state.workingTreeChanges.length === 0) {
      progress.set(40, vscode.l10n.t("Pushing to remote"));

      success(vscode.l10n.t("No changes to commit"));

      return await repo
        .push()
        .then(() => success(vscode.l10n.t("Backup completed")))
        .catch(() => success(vscode.l10n.t("Backup incomplete, failed to push to remote server.")));
    } else {
      progress.set(60, vscode.l10n.t("Creating commit"));

      // Message: Backup 2023/10/4 01:23:45 [GMT+8]
      const result = await repo
        .commit(`Backup ${getDateString(new Date())}`, { all: true })
        .then(() => true)
        .catch(() => false);

      if (result === false) return fail(vscode.l10n.t("Commit failed"));

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(80, vscode.l10n.t("Pushing to remote"));

      return await repo
        .push()
        .then(() => success(vscode.l10n.t("Backup complete, commit was created and pushed to remote server.")))
        .catch(() =>
          success(vscode.l10n.t("Backup incomplete, commit was created but failed to push to remote server."))
        );
    }
  } catch (e) {
    if (e instanceof ProgressCancelError) 0; // noop
    else throw e;

    return false;
  }
}

export async function pullChanges(): Promise<boolean> {
  const api = getGitAPI();

  const active = vscode.window.activeTextEditor;
  const repo = active ? api.getRepository(active.document.uri) : await pickRepository();
  if (!repo) return false;

  try {
    using progress = new Progress(vscode.l10n.t("Pull"));
    await progress.init();

    progress.set(10, vscode.l10n.t("Pulling from remote"));

    return await repo
      .pull()
      .then(() => success(vscode.l10n.t("Pull done")))
      .catch(() => fail(vscode.l10n.t("Pull failed, check your internet connection and Git output for more details.")));
  } catch (e) {
    if (e instanceof ProgressCancelError) 0; // noop
    else throw e;

    return false;
  }
}

export async function openProject(): Promise<boolean> {
  const projectHome = getProjectHome();
  const projectHomeUri = vscode.Uri.file(projectHome);

  if ((await makeDir(projectHome)) === false) {
    return fail(vscode.l10n.t("Failed to create project home directory"));
  }

  const options: vscode.OpenDialogOptions = {
    defaultUri: projectHomeUri,
    canSelectMany: false,
    openLabel: "Select",
    canSelectFiles: false,
    canSelectFolders: true,
    title: vscode.l10n.t("Select a Project Folder")
  };

  return await vscode.window.showOpenDialog(options).then(
    fileUri => {
      const fileUri0 = fileUri && fileUri[0];
      if (fileUri0 === undefined) return false;

      if (fileUri0.fsPath === projectHomeUri.fsPath) {
        vscode.window.showErrorMessage(vscode.l10n.t("You cannot open project home itself"));
        return false;
      }

      vscode.commands.executeCommand("vscode.openFolder", fileUri0);

      return true;
    },
    () => false
  );
}

export async function cloneProject(): Promise<boolean> {
  try {
    using progress = new Progress(vscode.l10n.t("Cloning Repository to Local"));
    await progress.init();

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(20, vscode.l10n.t("Fetching repository list"));

    const fetchResult = await getRepositoriesWithUserConfig();

    if (fetchResult === undefined) {
      return false;
    }

    if (fetchResult === null) {
      return fail(vscode.l10n.t("Failed to fetch repository list. The configuration may be incorrect."));
    }

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(40, vscode.l10n.t("Selecting repository"));

    const pickResult = await selectBitbucketRepository(
      fetchResult.values,
      vscode.l10n.t("Select a repository to clone"),
      (input: vscode.QuickPick<vscode.QuickPickItem>) => (progress.nextReportCallback = () => input.hide())
    );

    if (pickResult === null) {
      return fail(vscode.l10n.t("Operation cancelled by user"));
    }

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(60, vscode.l10n.t("Setting up project home directory"));

    const projectHome = getProjectHome();
    if ((await makeDir(projectHome)) === false) {
      return fail(vscode.l10n.t("Failed to create project home directory"));
    }

    const repo = pickResult.repository;
    const repoDir = path.join(projectHome, repo.slug);
    const repoDirStat = await stat(repoDir);
    if (repoDirStat !== null) {
      if (repoDirStat.type === vscode.FileType.Directory) {
        const open = await vscode.window.showWarningMessage(
          vscode.l10n.t("The project folder already exists, do you want to open it?"),
          { modal: true },
          vscode.l10n.t("Open")
        );

        if (open === vscode.l10n.t("Open")) {
          vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(repoDir));
        }

        return true;
      } else {
        return fail(vscode.l10n.t("The project folder already exists but is not a directory"));
      }
    }

    const bitbucketUser = await getBitbucketUser();
    const workspace = getBitbucketWorkspace();
    if (!bitbucketUser) {
      return fail(vscode.l10n.t('Use "4815 Tools: Setup Bitbucket Configuration" and try again'));
    }

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(80, vscode.l10n.t("Cloning repository"));

    const url = getRepositoryUrl(bitbucketUser, workspace, repo);
    const result = (await runCommand("git.clone", url, projectHome)) as [boolean, string];

    if (result[0]) {
      return success(vscode.l10n.t("Cloned repository successfully"));
    } else {
      return fail(vscode.l10n.t("Failed to clone repository"));
    }
  } catch (e) {
    if (e instanceof ProgressCancelError) 0; // noop
    else throw e;

    return false;
  }
}

export async function createProject(): Promise<boolean> {
  const api = getGitAPI();

  interface QuickPickItem extends vscode.QuickPickItem {
    key: string;
  }

  const state = {
    isPullTemplate: true,
    isCreateRemote: true,
    templateName: null!,
    templateDir: null!,
    projectName: null!,
    projectSlug: null!,
    projectDir: null!
  } as {
    isPullTemplate: boolean;
    isCreateRemote: boolean;
    templateName: string;
    templateDir: vscode.Uri;
    projectName: string;
    projectSlug: string;
    projectDir: vscode.Uri;
  };

  try {
    using progress = new Progress(vscode.l10n.t("Creating Project"));
    await progress.init();

    async function pickCreateOptions(input: MultiStepInput) {
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(5, vscode.l10n.t("Choosing options to create project"), () => input.dispose());

      const options = [
        {
          key: "pullTemplate",
          label: vscode.l10n.t("Pull the latest template from remote server")
        },
        {
          key: "createRemote",
          label: vscode.l10n.t("Create a remote repository"),
          detail: vscode.l10n.t("Unselect to create a local repository only. You can push it to remote server later.")
        }
      ] as QuickPickItem[];
      const pick = await input.showQuickPick<QuickPickItem, QuickPickParameters<QuickPickItem>>({
        title: vscode.l10n.t("Choose options to create project"),
        step: 1,
        totalSteps: 3,
        placeholder: vscode.l10n.t("Press enter to continue"),
        ignoreFocusOut: true,
        canSelectMany: true,
        selectedItems: options.slice(), // slice is unnecessary
        items: options,
        shouldResume: async () => false
      });

      state.isCreateRemote = !!pick.find(p => p.key === "createRemote");
      state.isPullTemplate = !!pick.find(p => p.key === "pullTemplate");

      return inputRepoTitle;
    }

    async function inputRepoTitle(input: MultiStepInput) {
      const templateHome = getTemplateHome();
      const templateRepoSlug = getMainTemplateRepo();
      const templateRepoDir = path.join(templateHome, templateRepoSlug);

      if (state.isPullTemplate) {
        progress.set(10, vscode.l10n.t("Pulling template repository"), () => input.dispose());

        const repo = await api.openRepository(vscode.Uri.file(templateRepoDir));

        if (!repo) {
          fail(vscode.l10n.t("Failed to open template repository"));
          return;
        }

        if (repo.state.indexChanges.length !== 0) {
          fail(vscode.l10n.t("Template pull failed, repository has uncommitted changes."));
          return;
        }

        await repo
          .pull()
          .then(() => success(vscode.l10n.t("Template pull done")))
          .catch(() => success(vscode.l10n.t("Template pull failed, check your internet connection.")));
      }
      progress.set(15, vscode.l10n.t("Choosing template"), () => input.dispose());

      const templateRepoDirStat = await stat(templateRepoDir);
      const fileList =
        templateRepoDirStat === null ? [] : await vscode.workspace.fs.readDirectory(vscode.Uri.file(templateRepoDir));
      const directoryList = fileList.filter(f => f[1] === vscode.FileType.Directory && f[0] !== ".git").map(f => f[0]);

      if (directoryList.length === 0) {
        fail(vscode.l10n.t("No templates available"));
        return;
      }

      const allTemplateOptions = directoryList.map<QuickPickItem>(d => ({
        key: d,
        label: d
      }));

      const pick = await input.showQuickPick<QuickPickItem, QuickPickParameters<QuickPickItem>>({
        title: vscode.l10n.t("Choose template"),
        step: 2,
        totalSteps: 3,
        placeholder: vscode.l10n.t("Select a template to create project from"),
        ignoreFocusOut: true,
        items: allTemplateOptions,
        shouldResume: async () => false
      });

      if (pick.length === 0) return undefined;

      state.templateName = pick[0].key;
      state.templateDir = vscode.Uri.file(path.join(templateRepoDir, state.templateName));

      return inputProjectName;
    }

    async function inputProjectName(input: MultiStepInput) {
      let isFetchingRepoList = true;

      progress.set(25, vscode.l10n.t("Fetching repository list"), () => isFetchingRepoList && input.dispose());

      const repositoriesPromise = getRepositoriesWithUserConfig().then(value => {
        isFetchingRepoList = false;
        progress.set(35, vscode.l10n.t("Entering project name"), () => input.dispose());
        if (value === null) {
          fail(vscode.l10n.t("Failed to fetch repository list, check your internet connection."));
        }
        return value?.values ?? [];
      });

      const isAddPrefixToNewRepo = getIsAddPrefixToNewRepo();

      const getProjectSlug = (projectName: string) => {
        const projectSlugPrefix = isAddPrefixToNewRepo
          ? `${getCompetitionSessionYearString(new Date())}-${getTemplateNamePrefix(state.templateName)}-`
          : "";
        return getProjectSlugFromName(projectSlugPrefix + projectName);
      };

      const result = await input.showInputBox({
        title: vscode.l10n.t("Enter the project name"),
        step: 3,
        totalSteps: 3,
        value: "",
        placeholder: vscode.l10n.t("Project name"),
        ignoreFocusOut: true,
        prompt: vscode.l10n.t("Please enter the name of the project to create"),
        validate: async (projectName: string, inputBox: vscode.InputBox) => {
          const projectSlug = getProjectSlug(projectName);
          let success = false;

          try {
            if (projectName.length < 3 || projectName.length > 62) {
              return vscode.l10n.t("Project name must be between 3 and 62 characters");
            }

            if (projectSlug.length < 3 || projectSlug.length > 62) {
              return vscode.l10n.t("Repository slug must be between 3 and 62 characters");
            }

            const repositories = await repositoriesPromise;
            const repoBySlug = repositories.find(r => r.slug === projectSlug);
            if (repoBySlug !== undefined) {
              if (state.isCreateRemote) {
                return vscode.l10n.t("Repository with the same slug already exists on remote server");
              } else {
                return vscode.l10n.t(
                  "Repository with the same slug already exists on remote server. You are recommended to create one with an unique slug."
                );
              }
            }
            const repoByName = repositories.find(r => r.name === projectName);
            if (repoByName !== undefined) {
              if (state.isCreateRemote) {
                return vscode.l10n.t("Repository with the same name already exists on remote server");
              } else {
                return vscode.l10n.t(
                  "Repository with the same name already exists on remote server. You are recommended to create one with an unique name."
                );
              }
            }

            const projectDir = path.join(projectHome, projectSlug);
            const projectDirStat = await stat(projectDir);
            if (projectDirStat !== null) {
              if (projectDirStat.type === vscode.FileType.Directory) {
                return vscode.l10n.t("The project folder already exists");
              } else {
                return vscode.l10n.t("The project folder already exists but is not a directory");
              }
            }

            success = true;
            return undefined;
          } finally {
            if (success) inputBox.prompt = vscode.l10n.t('The repository slug will be "{0}"', projectSlug);
            else inputBox.prompt = vscode.l10n.t("Please enter the name of the project to create");
          }
        },
        shouldResume: async () => false
      });

      state.projectName = result;
      state.projectSlug = getProjectSlug(state.projectName);
      state.projectDir = vscode.Uri.file(path.join(projectHome, state.projectSlug));
    }

    const projectHome = getProjectHome();
    if ((await makeDir(projectHome)) === false) {
      return fail(vscode.l10n.t("Failed to create project home directory"));
    }

    await MultiStepInput.run(input => pickCreateOptions(input));
    if (state.projectName === null) return fail(vscode.l10n.t("Operation cancelled by user"));

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(45, vscode.l10n.t("Copying template to the project directory"));
    const copyResult = await vscode.workspace.fs.copy(state.templateDir, state.projectDir).then(
      () => true,
      () => false
    );
    if (copyResult === false) return fail(vscode.l10n.t("Failed to copy template to the project directory"));

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(55, vscode.l10n.t("Initializing project Git repository"));
    const repo = await api.init(state.projectDir, { defaultBranch: "main" });
    if (repo === null) return fail(vscode.l10n.t("Failed to initialize project Git repository"));

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(65, vscode.l10n.t("Creating initial commit"));
    await setupRepositoryConfiguration(repo);
    const commitResult = await repo
      .commit("Initial commit", { all: true })
      .then(() => true)
      .catch(() => false);
    if (commitResult === false) return fail(vscode.l10n.t("Commit failed"));

    if (state.isCreateRemote) {
      const bitbucketUser = (await getBitbucketUser())!;
      const workspace = getBitbucketWorkspace();
      const projectKey = getBitbucketProjectKey();

      const repoUrl = getRepositoryUrl(bitbucketUser, getBitbucketWorkspace(), { slug: state.projectSlug });

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(75, vscode.l10n.t("Setting up remote repository"));
      await repo.addRemote("origin", repoUrl);

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(80, vscode.l10n.t("Creating remote repository"));
      const createResult = await createRepository(
        bitbucketUser,
        workspace,
        projectKey,
        state.projectName,
        state.projectSlug
      );
      if (createResult === null) return fail(vscode.l10n.t("Failed to create remote repository"));

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(90, vscode.l10n.t("Pushing to remote repository"));
      const pushResult = await repo.push("origin", "main", true);
      if (pushResult === null) return fail(vscode.l10n.t("Failed to push to remote repository"));
    }

    vscode.commands.executeCommand("vscode.openFolder", state.projectDir, { forceNewWindow: true });

    return success(vscode.l10n.t("Project created successfully"));
  } catch (e) {
    if (e instanceof ProgressCancelError) 0; // noop
    else throw e;

    return false;
  }
}

export async function setupProjectAndRemote(): Promise<boolean> {
  const api = getGitAPI();

  const active = vscode.window.activeTextEditor;
  const repo = active ? api.getRepository(active.document.uri) : await pickRepository();
  if (!repo) return false;

  try {
    using progress = new Progress(vscode.l10n.t("Setup Project and Remote Repository"));
    await progress.init();

    // get folder name in repo.rootUri
    const repoSlug = path.basename(repo.rootUri.fsPath);

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(25, vscode.l10n.t("Fetching repository list"));

    const fetchResult = await getRepositoriesWithUserConfig();

    if (fetchResult === undefined) {
      return false;
    }

    if (fetchResult === null) {
      return fail(vscode.l10n.t("Failed to fetch repository list. The configuration may be incorrect."));
    }

    const find = fetchResult.values.find(r => r.slug === repoSlug);

    const bitbucketUser = (await getBitbucketUser())!;
    const repoUrl = getRepositoryUrl(bitbucketUser, getBitbucketWorkspace(), { slug: repoSlug });

    if (find === undefined) {
      const message = vscode.l10n.t(
        'The repository "{0}" does not exist on remote server. Do you want to create it and push to remote server?',
        repoSlug
      );
      const create = vscode.l10n.t("Create Remote Repository & Push");
      const pick = await vscode.window.showWarningMessage(message, { modal: true }, create);

      if (pick === create) {
        ////////////////////////////////////////////////////////////////////////////
        ////////////////////////////////////////////////////////////////////////////
        ////////////////////////////////////////////////////////////////////////////

        progress.set(50, vscode.l10n.t("Creating remote repository"));

        const createResult = await createRepository(
          bitbucketUser,
          getBitbucketWorkspace(),
          getBitbucketProjectKey(),
          getProjectHome(),
          repoSlug
        );
        if (createResult === null) return fail(vscode.l10n.t("Failed to create remote repository"));
      } else {
        return false;
      }

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(75, vscode.l10n.t("Pushing to remote repository"));

      const pushResult = await repo.push("origin", "main", true);
      if (pushResult === null) return fail(vscode.l10n.t("Failed to push to remote repository"));
    } else {
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(50, vscode.l10n.t("Linking repository to remote"));

      await repo.removeRemote("origin");
      await repo.addRemote("origin", repoUrl);

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(75, vscode.l10n.t("Pushing to remote repository"));

      const pushResult = await repo.push("origin", "main", true);
      if (pushResult === null) return fail(vscode.l10n.t("Failed to push to remote repository"));
    }

    return success(vscode.l10n.t("Setup Project and Remote Repository Done"));
  } catch (e) {
    if (e instanceof ProgressCancelError) 0; // noop
    else throw e;

    return false;
  }
}

export async function setupBitbucketConfiguration(): Promise<boolean> {
  const config = getConfig();

  const info: UserInfo<string> = userInfo();
  const homeDir = info.homedir;
  const machineName = info.username;
  const projectDir = path.join(homeDir, "4815-projects");
  const templateDir = path.join(homeDir, "4815-templates");

  const setValueIfNotSet = (configName: string, value: string) => {
    const section = config.inspect<string>(configName);
    if (section?.globalValue === undefined) {
      config.update(configName, value, vscode.ConfigurationTarget.Global);
    }
  };

  setValueIfNotSet("remote.bitbucket.machineName", machineName);
  setValueIfNotSet("projects.projectHome", projectDir);
  setValueIfNotSet("projects.templateHome", templateDir);

  const username = config.get<string>("remote.bitbucket.username") ?? "";

  const pwd = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Enter the password for the Bitbucket account "{0}"', username),
    ignoreFocusOut: true,
    password: true
  });

  if (pwd === undefined || pwd === "") {
    return fail(vscode.l10n.t("Operation cancelled by user"));
  }

  getSecrets()?.store("4815-tools.remote.bitbucket.password", pwd);

  success(vscode.l10n.t("Configuration Done"));

  try {
    using progress = new Progress(vscode.l10n.t("Testing Bitbucket Configuration"));
    await progress.init();

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    progress.set(25, vscode.l10n.t("Fetching repository list"));

    const fetchResult = await getRepositoriesWithUserConfig();
    if (fetchResult === undefined) {
      return false;
    } else if (fetchResult === null) {
      return fail(vscode.l10n.t("Failed to fetch repository list. The configuration may be incorrect."));
    } else {
      success(vscode.l10n.t("Fetched repository list successfully"));
    }

    const bitbucketUser = await getBitbucketUser();
    if (!bitbucketUser) {
      return fail(vscode.l10n.t('Use "4815 Tools: Setup Bitbucket Configuration" and try again'));
    }

    const api = getGitAPI();

    const templateHome = getTemplateHome();
    const templateRepoSlug = getMainTemplateRepo();
    const templateRepoDir = path.join(templateHome, templateRepoSlug);
    const templateRepoDirUri = vscode.Uri.file(templateRepoDir);
    const templateRepoUrl = getRepositoryUrl(bitbucketUser, getBitbucketWorkspace(), { slug: templateRepoSlug });

    const repo = await api.openRepository(templateRepoDirUri);

    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////

    if (repo === null) {
      progress.set(50, vscode.l10n.t("Setting up template home directory"));

      if ((await makeDir(templateHome)) === false) {
        return fail(vscode.l10n.t("Failed to create template home directory"));
      }

      const templateRepoDirStat = await stat(templateRepoDir);
      const fileList = templateRepoDirStat === null ? [] : await vscode.workspace.fs.readDirectory(templateRepoDirUri);

      if (fileList.length !== 0) {
        return fail(vscode.l10n.t("Template repository directory is not empty"));
      }

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(75, vscode.l10n.t("Cloning template repository"));

      await runCommand("git.clone", templateRepoUrl, templateHome);

      const repoOpenAttempt = await api.openRepository(templateRepoDirUri);
      return repoOpenAttempt !== null
        ? success(vscode.l10n.t("Cloned template repository successfully"))
        : fail(vscode.l10n.t("Failed to clone template repository"));
    } else {
      progress.set(75, vscode.l10n.t("Relink template repository to remote"));

      await repo.removeRemote("origin");
      await repo.addRemote("origin", templateRepoUrl);
      await repo.fetch("origin");

      const branchList = await repo.getBranches({ remote: false });
      for (const branch of branchList) {
        if (branch.type === RefType.Head && branch.name)
          await repo.setBranchUpstream(branch.name, `origin/${branch.name}`);
      }

      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////
      ////////////////////////////////////////////////////////////////////////////

      progress.set(25, vscode.l10n.t("Pulling template repository"));

      if (repo.state.indexChanges.length !== 0) {
        return fail(vscode.l10n.t("Template pull failed, repository has uncommitted changes."));
      }

      return await repo
        .pull()
        .then(() => success(vscode.l10n.t("Template pull done")))
        .catch(() => fail(vscode.l10n.t("Template pull failed, check your internet connection.")));
    }
  } catch (e) {
    if (e instanceof ProgressCancelError) 0; // noop
    else throw e;

    return false;
  }
}

class RepositoryPick implements vscode.QuickPickItem {
  get label(): string {
    return path.basename(this.repository.rootUri.path);
  }

  constructor(
    public readonly repository: Repository,
    public readonly index: number
  ) {}
}

// From https://github.com/microsoft/vscode/blob/main/extensions/git/src/model.ts#L748
export async function pickRepository(): Promise<Repository | undefined> {
  const api = getGitAPI();

  const openRepos = api.repositories;

  if (openRepos.length === 0) {
    throw new Error(vscode.l10n.t("There are no available repositories"));
  }

  const picks = openRepos.map((repository, index) => new RepositoryPick(repository, index));
  const active = vscode.window.activeTextEditor;
  const repository = active && api.getRepository(active.document.uri);
  const index = picks.findIndex(pick => pick.repository === repository);

  // Move repository pick containing the active text editor to appear first
  if (index > -1) {
    picks.unshift(...picks.splice(index, 1));
  }

  const placeHolder = vscode.l10n.t("Choose a repository");
  const pick = await vscode.window.showQuickPick(picks, { placeHolder });

  return pick && pick.repository;
}

let extensionContext: vscode.ExtensionContext | null = null;
let extensionConfig: vscode.WorkspaceConfiguration | null = null;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  const globalConfig = vscode.workspace.getConfiguration();
  globalConfig.update(
    "vexrobotics.vexcode.Project.RunAfterDownload",
    true,
    vscode.ConfigurationTarget.Global, // It only supports global
    true
  );
  globalConfig.update("git.openRepositoryInParentFolders", "always", vscode.ConfigurationTarget.Global, true);

  const registerCommand = (command: string, callback: (...args: any[]) => any) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        if (extensionConfig !== null) return fail(vscode.l10n.t("Please wait for the previous command to finish."));

        try {
          extensionConfig = vscode.workspace.getConfiguration("4815-tools");
          return callback();
        } finally {
          extensionConfig = null;
        }
      })
    );
  };

  registerCommand("4815-tools.flow-build", runFlow.bind(null, "build"));
  registerCommand("4815-tools.flow-rebuild", runFlow.bind(null, "rebuild"));
  registerCommand("4815-tools.backup-changes", backupChanges);
  registerCommand("4815-tools.pull-changes", pullChanges);
  registerCommand("4815-tools.open-project", openProject);
  registerCommand("4815-tools.clone-project", cloneProject);
  registerCommand("4815-tools.create-project", createProject);
  registerCommand("4815-tools.setup-project-and-remote", setupProjectAndRemote);
  registerCommand("4815-tools.setup-bitbucket-configuration", setupBitbucketConfiguration);
}

export function deactivate() {
  extensionContext = null;
  extensionConfig = null;
}

