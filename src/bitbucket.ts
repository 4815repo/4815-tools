import * as vscode from "vscode";
import fetch, { Headers } from "node-fetch";
import { getConfigValue, getSecrets } from "./extension";

export interface BitbucketUser {
  username: string;
  password: string;
}

export interface BitbucketRepositoryIdentifier {
  slug: string;
}

export interface BitbucketRepository extends BitbucketRepositoryIdentifier {
  name: string;
  scm: string;
  updated_on: string; // eslint-disable-line @typescript-eslint/naming-convention
}

export interface BitbucketRepositoryList {
  values: BitbucketRepository[];
}

export function getBasicAuth(user: BitbucketUser): string {
  return "Basic " + Buffer.from(`${user.username}:${user.password}`).toString("base64");
}

export async function getRepositories(
  user: BitbucketUser,
  workspace: string,
  projectKey: string
): Promise<BitbucketRepositoryList | null> {
  const header = new Headers();
  header.append("Authorization", getBasicAuth(user));

  const requestOptions = { method: "GET", headers: header };

  try {
    const response = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}?q=project.key="${projectKey}"&fields=values.name,values.slug,values.scm,values.updated_on&sort=-updated_on&pagelen=100`,
      requestOptions
    );

    if (response.status !== 200) return null;

    const resultInJSON = await response.json();

    return resultInJSON as BitbucketRepositoryList;
  } catch (e) {
    return null;
  }
}

export async function createRepository(
  user: BitbucketUser,
  workspace: string,
  projectKey: string,
  repositoryName: string,
  repositorySlug: string
): Promise<BitbucketRepository | null> {
  const header = new Headers();
  header.append("Content-Type", "application/json");
  header.append("Authorization", getBasicAuth(user));

  const body = JSON.stringify({
    scm: "git",
    project: { key: projectKey },
    name: repositoryName,
    language: "c++",
    is_private: true // eslint-disable-line @typescript-eslint/naming-convention
  });

  const requestOptions = { method: "POST", headers: header, body: body };

  try {
    const response = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${repositorySlug}?fields=name,slug,scm,updated_on`,
      requestOptions
    );

    if (response.status !== 200) return null;

    const resultInJSON = await response.json();

    return resultInJSON as BitbucketRepository;
  } catch (e) {
    return null;
  }
}

export async function getBitbucketUser(): Promise<BitbucketUser | null> {
  const username = getConfigValue<string>("remote.bitbucket.username");
  const password = await getSecrets()?.get("4815-tools.remote.bitbucket.password");

  return password ? { username, password } : null;
}

export function getBitbucketWorkspace(): string {
  return getConfigValue<string>("remote.bitbucket.workspace");
}

export function getBitbucketProjectKey(): string {
  return getConfigValue<string>("remote.bitbucket.project");
}

export function getRepositoryUrl(
  user: BitbucketUser,
  workspace: string,
  repository: BitbucketRepositoryIdentifier
): string {
  return `https://${user.username}:${user.password}@bitbucket.org/${workspace}/${repository.slug}.git`;
}

export async function getRepositoriesWithUserConfig(): Promise<BitbucketRepositoryList | null | undefined> {
  const user = await getBitbucketUser();
  if (user === null) {
    vscode.window.showErrorMessage(vscode.l10n.t('Use "4815 Tools: Setup Bitbucket Configuration" and try again'));
    return undefined;
  }

  return await getRepositories(user, getBitbucketWorkspace(), getBitbucketProjectKey());
}
