const util = require('./util'),
  path = require('path'),
  run = require('./shell').run,
  config = require('./config'),
  GitHubApi = require('github'),
  repoUrlParser = require('parse-github-repo-url'),
  repoPathParser = require('parse-repo'),
  _ = require('lodash'),
  retry = require('async-retry'),
  glob = require('glob'),
  log = require('./log');

const noop = Promise.resolve();
const commitRefRe = /#.+$/;
var _githubClient = null;

function isGitRepo() {
  return run('!git rev-parse --git-dir', {isReadOnly: true});
}

function tagExists(tag) {
  return run(`!git show-ref --tags --quiet --verify -- "refs/tags/${tag}"`, {isReadOnly: true}).then(() => true, () => false);
}

function getRemoteUrl() {
  return run('!git config --get remote.origin.url', {isReadOnly: true}).then(stdout => {
    if(stdout) {
      return stdout.trim();
    }
    throw new Error('Could not get remote Git url.');
  });
}

function isWorkingDirClean(requireCleanWorkingDir) {
  return requireCleanWorkingDir ? run('!git diff-index --name-only HEAD --exit-code', {isReadOnly: true}).catch(() => {
    throw new Error('Working dir must be clean.');
  }) : noop;
}

function hasChanges(repo) {
  // Inverted: reject if run promise is resolved (i.e. `git diff-index` returns exit code 0)
  return new Promise(resolve => {
    run('!git diff-index --name-only HEAD --exit-code', {isReadOnly: true}).then(() => {
      config.setRuntimeOption(`${repo}_has_changes`, false);
      log.warn(`No changes in ${repo} repo.`);
      resolve();
    }).catch(resolve);
  });
}

function clone(repo, dir) {
  const commitRef = repo.match(commitRefRe);
  const branch = commitRef && commitRef[0] ? commitRef[0].replace(/^\#/, '') : 'master';
  const cleanRepo = repo.replace(commitRef, '');
  return run(`rm -rf ${dir}`).then(() => {
    return run(`git clone ${cleanRepo} -b ${branch} --single-branch ${dir}`).catch(err => {
      log.error(`Unable to clone ${repo}`);
      throw err;
    })
  });
}

function stage(file) {
  if(file) {
    const files = typeof file === 'string' ? file : file.join(' ');
    return run(`git add ${files}`).catch(err => {
      log.debug(err);
      log.warn(`Could not stage ${file}`);
    });
  } else {
    return noop;
  }
}

function stageDir(baseDir) {
  baseDir = baseDir || '.';
  return run(`git add ${baseDir} --all`);
}

function status() {
  return run('!git status --short --untracked-files=no', {isReadOnly: true}).then(result => {
    // Output also when not verbose
    !config.isVerbose && log.log(result.output);
  });
}

function commit(path, message, version) {
  return run(`git commit ${config.isForce ? '--allow-empty ' : ''}--message="${util.format(message, version)}"`,
    path
  ).catch(err => {
    log.debug(err);
    log.warn('No changes to commit. The latest commit will be tagged.');
  });
}

function tag(version, tag, annotation) {
  const force = config.isForce ? '--force ' : '';
  const message = util.format(annotation, version);
  const formattedVersion = util.format(tag, version);
  return run(`git tag ${force}--annotate --message="${message}" ${formattedVersion}`).then(() => {
    config.setRuntimeOption('tag_set', true);
  }).catch(() => {
    log.warn(`Could not tag. Does tag "${version}" already exist? Use --force to move a tag.`);
  });
}

function getLatestTag() {
  return run('!git describe --tags --abbrev=0', {isReadOnly: true}).then(result => {
    const latestTag = result && result.output ? result.output.trim() : null;
    return latestTag;
  });
}

function push(remoteUrl, pushUrl) {
  const repository = pushUrl || '';
  return run(`git push ${repository}`).catch(err => {
    log.error('Please make sure an upstream remote repository is configured for the current branch. Example commands:\n' +
      `git remote add origin ${remoteUrl}\n` +
      'git push --set-upstream origin master');
    throw new Error(err);
  });
}

function pushTags(version, pushUrl) {
  const repository = pushUrl || '';
  return run(`git push --follow-tags ${config.isForce ? '--force ' : ''}${repository}`).catch(() => {
    log.error(`Could not push tag(s). Does tag "${version}" already exist? Use --force to move a tag.`);
  });
}

function getGithubClient(repo) {
  if(!_githubClient) {
    _githubClient = new GitHubApi({
      version: '3.0.0',
      debug: config.isDebug,
      protocol: 'https',
      host: repo.host === 'github.com' ? '' : repo.host,
      pathPrefix: repo.host === 'github.com' ? '' : '/api/v3',
      timeout: 10000,
      headers: {
        'user-agent': 'webpro/release-it'
      }
    });

    _githubClient.authenticate({
      type: 'oauth',
      token: config.getRuntimeOption('github_token')
    });
  }
  return _githubClient;
}

function getGithubToken(tokenRef) {
  const token = process.env[tokenRef];
  config.setRuntimeOption('github_token', token);
  return token;
}

function getChangelog(options) {
  function runChangelogCommand(command) {
    return run(command, {isReadOnly: true}).then(result => {
      if(config.isVerbose) {
        process.stdout.write('\n');
      }
      config.setRuntimeOption('changelog', result.output);
      return options;
    });
  }

  if(options.changelogCommand) {
    if(options.changelogCommand.match(/\[REV_RANGE\]/)) {
      const previousVersion = config.getRuntimeOption('previousVersion');
      const previousTag = util.format(options.src.tagName, previousVersion);
      return tagExists(previousTag).then(hasTag => {
        const command = options.changelogCommand.replace(/\[REV_RANGE\]/, hasTag ? `${previousTag}...HEAD` : '');
        return runChangelogCommand(command);
      }).catch(err => {
        log.warn('Probably the current version in package.json is not a known tag in the repository.');
        log.debug(err);
        throw new Error(`Could not create changelog from latest tag (${previousTag}) to HEAD.`);
      });
    } else {
      return runChangelogCommand(options.changelogCommand);
    }
  } else {
    return noop;
  }
}

function parseRepo(remoteUrl) {
  const result = repoUrlParser(remoteUrl);
  const owner = result[0];
  const project = result[1];
  const branch = result[2];
  const rename_proj = project.replace(/\./g, "-");
  const parseResult = repoPathParser(remoteUrl.replace(project, rename_proj));
  const repo = _.extend({}, parseResult, {project, remote:remoteUrl, repository: owner + "/" + project});
  return repo;
}

function release(options, remoteUrl, tagName) {
  const repo = parseRepo(remoteUrl);
  const version = config.getRuntimeOption('version');
  
  log.execution('node-github releases#createRelease (start)', repo.repository, repo.owner, repo.project);

  const githubClient = getGithubClient(repo);
  const retries = 3;

  if(!config.isDryRun) {
    return retry((bail, attempt) => new Promise((resolve, reject) => {
      const tag_name = util.format(tagName, version);
      const name = util.format(options.github.releaseName, version);
      githubClient.repos.createRelease({
        owner: repo.owner,
        repo: repo.project,
        tag_name,
        name,
        body: config.getRuntimeOption('changelog'),
        prerelease: options.github.preRelease,
        draft: options.github.draft
      }, (err, response) => {
        if(err) {
          const logFn = log[attempt === retries ? 'error' : 'warn'];
          logFn(`${err.defaultMessage} (Attempt ${attempt + 1} of ${retries})`);
          logFn(err.message);
          return reject(err);
        } else {
          config.setRuntimeOption('githubReleaseId', response.data.id);
          log.execution(`node-github releases#createRelease (success) ${response.meta.location} ${response.data.tag_name} "${response.data.name}"`);
          log.debug(response);
          resolve();
        }
      });
    }, {
      retries
    }))
  } else {
    return noop;
  }
}

function uploadAsset(repo, filePath) {
  const githubClient = getGithubClient(repo);
  const id = config.getRuntimeOption('githubReleaseId');
  const name = path.basename(filePath);
  return new Promise((resolve, reject) => {
    githubClient.repos.uploadAsset({
      owner: repo.owner,
      repo: repo.project,
      id,
      filePath,
      name
    }, (err, response) => {
      if(err) return reject(err);
      log.execution('node-github releases#uploadAsset (success)', response.data.browser_download_url);
      log.debug(response);
      resolve();
    });
  });
}

function uploadAssets(options, remoteUrl, assets) {
  const repo = parseRepo(remoteUrl);

  log.execution('node-github releases#uploadAsset (start)', repo.repository, repo.owner, repo.project);

  if(!config.isDryRun) {
    return new Promise((resolve, reject) => {
      glob(assets, function (err, files) {
        if(err) return reject(err);
        if(!files.length) {
          log.execution('node-github releases#uploadAsset', 'No assets found', assets, process.cwd());
        }
        Promise.all(files.map(filePath => uploadAsset(repo, filePath))).then(resolve, reject);
      })
    })
  } else {
    return noop;
  }
}

module.exports = {
  isGitRepo,
  getRemoteUrl,
  status,
  clone,
  stage,
  stageDir,
  commit,
  tag,
  getLatestTag,
  push,
  pushTags,
  getChangelog,
  getGithubToken,
  release,
  uploadAssets,
  isWorkingDirClean,
  hasChanges
};
