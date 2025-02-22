import {BaseCommand, WorkspaceRequiredError}                              from '@yarnpkg/cli';
import {Cache, Configuration, Manifest, Project, StreamReport, Workspace} from '@yarnpkg/core';
import {structUtils}                                                      from '@yarnpkg/core';
import {Command, Usage}                                                   from 'clipanion';
import * as yup                                                           from 'yup';

// eslint-disable-next-line arca/no-default-export
export default class WorkspacesFocus extends BaseCommand {
  @Command.Rest()
  workspaces: Array<string> = [];

  @Command.Boolean(`--json`, {description: `Format the output as an NDJSON stream`})
  json: boolean = false;

  @Command.Boolean(`--production`, {description: `Only install regular dependencies by omitting dev dependencies`})
  production: boolean = false;

  @Command.Boolean(`-A,--all`, {description: `Install the entire project`})
  all: boolean = false;

  static usage: Usage = Command.Usage({
    category: `Workspace-related commands`,
    description: `install a single workspace and its dependencies`,
    details: `
      This command will run an install as if the specified workspaces (and all other workspaces they depend on) were the only ones in the project. If no workspaces are explicitly listed, the active one will be assumed.

      Note that this command is only very moderately useful when using zero-installs, since the cache will contain all the packages anyway - meaning that the only difference between a full install and a focused install would just be a few extra lines in the \`.pnp.js\` file, at the cost of introducing an extra complexity.

      If the \`-A,--all\` flag is set, the entire project will be installed. Combine with \`--production\` to replicate the old \`yarn install --production\`.
    `,
  });

  static schema = yup.object().shape({
    all: yup.bool(),
    workspaces: yup.array().when(`all`, {
      is: true,
      then: yup.array().max(0, `Cannot specify workspaces when using the --all flag`),
      otherwise: yup.array(),
    }),
  });

  @Command.Path(`workspaces`, `focus`)
  async execute() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);
    const cache = await Cache.find(configuration);

    let requiredWorkspaces: Set<Workspace>;
    if (this.all) {
      requiredWorkspaces = new Set(project.workspaces);
    } else if (this.workspaces.length === 0) {
      if (!workspace)
        throw new WorkspaceRequiredError(project.cwd, this.context.cwd);

      requiredWorkspaces = new Set([workspace]);
    } else {
      requiredWorkspaces = new Set(this.workspaces.map(name => {
        return project.getWorkspaceByIdent(structUtils.parseIdent(name));
      }));
    }

    // First we compute the dependency chain to see what workspaces are
    // dependencies of the one we're trying to focus on.
    //
    // Note: remember that new elements can be added in a set even while
    // iterating over it (because they're added at the end)

    for (const workspace of requiredWorkspaces) {
      for (const dependencyType of Manifest.hardDependencies) {
        for (const descriptor  of workspace.manifest.getForScope(dependencyType).values()) {
          const matchingWorkspace = project.tryWorkspaceByDescriptor(descriptor);

          if (matchingWorkspace === null)
            continue;

          requiredWorkspaces.add(matchingWorkspace);
        }
      }
    }

    // Then we go over each workspace that didn't get selected, and remove all
    // their dependencies.
    // Add the unselected workspaces into a list of evicted workspaces
    const evictions = new Array<Workspace>();
    for (const workspace of project.workspaces) {
      if (requiredWorkspaces.has(workspace)) {
        if (this.production) {
          workspace.manifest.devDependencies.clear();
        }
      } else {
        workspace.manifest.dependencies.clear();
        workspace.manifest.devDependencies.clear();
        workspace.manifest.peerDependencies.clear();
        if (project.topLevelWorkspace !== workspace) {
          evictions.push(workspace);
        }
      }
    }
    
    // Remove the unselected workspaces from the project's internal data structures
    for (const evictedWorkspace of evictions){
      project.workspacesByCwd.delete(evictedWorkspace.cwd);
      project.workspacesByIdent.delete(evictedWorkspace.locator.identHash);
      project.workspaces.splice(project.workspaces.indexOf(evictedWorkspace), 1);
    }

    // And finally we can run the install, but we have to make sure we don't
    // persist the project state on the disk (otherwise all workspaces would
    // lose their dependencies!).

    const report = await StreamReport.start({
      configuration,
      json: this.json,
      stdout: this.context.stdout,
      includeLogs: true,
    }, async (report: StreamReport) => {
      await project.install({cache, report, persistProject: false});
      // Virtual package references may have changed so persist just the install state.
      await project.persistInstallStateFile();
    });

    return report.exitCode();
  }
}
