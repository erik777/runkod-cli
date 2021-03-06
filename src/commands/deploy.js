import fs from 'fs'
import path from 'path';

import glob from 'glob';
import tmp from 'tmp';
import JSZip from 'jszip';
import minimatch from 'minimatch';
import chalk from 'chalk';

import *  as ui from '../ui';
import * as utils from '../utils';
import * as log from '../log';
import * as helpers from '../helpers';
import * as formatter from '../formatter.js';
import {_t} from '../i18n';
import * as constants from '../constants';

module.exports = async (self, config) => {

  const projectID = config.argv.hasOwnProperty('project') ? config.argv.project : null;
  const folderId = config.argv.hasOwnProperty('folder') ? config.argv.folder : null;
  const activate = config.argv.hasOwnProperty('activate');

  let projects = null;
  let project = null;
  let folder = null;
  let deployment = null;
  let bundlePath = null;

  const send = async () => {
    const spin = ui.spinner(_t('deploy.uploading', {p: 0}));
    spin.start();

    const {size: fileSize} = fs.statSync(bundlePath);
    let uploaded = 0;

    const file = fs.createReadStream(bundlePath).on('data', (chunk) => {
      uploaded += chunk.length;
      const percent = Math.ceil((uploaded / fileSize) * 100);
      spin.text = _t('deploy.uploading', {p: percent});
    });

    try {
      deployment = await config.api.deploy(project.id, {file});
    } catch (e) {
      throw e;
    } finally {
      spin.stop();
      fs.unlinkSync(bundlePath);
    }

    log.success(_t('deploy.uploaded'));

    if (deployment.isActive === false) {
      const r = activate ? true : await ui.confirm(_t('deploy.activate'));
      if (r) {
        await config.api.activateDeployment(project.id, deployment.id);
        log.success(_t('deploy.activated'));
      }
    } else {
      log.success(_t('deploy.activated'));
    }

    project = await config.api.getProject(project.id).catch();
    if (project) {
      console.log(formatter.projectFormatter(project));
      console.log(formatter.SEPARATOR);
    }
  };

  const inspectFiles = async (files) => {
    // no html files
    if (files.filter(x => x.endsWith('.html')).length === 0) {
      const r = await ui.confirm(_t('deploy.warning-no-html')).catch();
      if (!r) {
        return false;
      }
    }

    // server side file detected
    if (files.filter(x => x.endsWith('.php')).length > 0) {
      const r = await ui.confirm(_t('deploy.warning-server-side')).catch();
      if (!r) {
        return false;
      }
    }

    return true;
  };

  const makeBundle = async () => {
    const pattern = `${folder}/**/**`;
    const paths = glob.sync(pattern, {silent: true, absolute: true});
    const files = paths
      .filter((x) => !utils.isDir(x))
      .filter(x => {
        return constants.GLOB_RULES.find(p => {
          return minimatch(x, p, {matchBase: true});
        }) === undefined
      });

    if (files.length === 0) {
      console.info('No files matched.');
      return;
    }

    if (!await inspectFiles(files)) {
      log.info(_t('deploy.cancelled'));
      return;
    }

    const replace = `${folder}/`;

    const zip = new JSZip();

    files.forEach(function (file) {
      const buff = fs.readFileSync(file);
      const zipPath = file.replace(replace, '');
      zip.file(zipPath, buff);
    });

    const file = tmp.fileSync();
    bundlePath = file.name;

    zip.generateNodeStream({type: 'nodebuffer', compression: 'DEFLATE', streamFiles: true})
      .pipe(fs.createWriteStream(bundlePath))
      .on('finish', function () {
        send();
      });
  };

  const validateFolder = function (retry) {
    if (!folder) {
      log.error(_t('deploy.invalid-folder'));
      if (retry) {
        selectFolder();
      }
      return;
    }

    folder = path.resolve(folder);

    // Must be a valid directory
    if (!utils.isDir(folder)) {
      log.error(_t('deploy.invalid-folder'));
      if (retry) {
        selectFolder();
      }
      return;
    }

    if (folderId) {
      console.log(`${chalk.bold(_t('deploy.selected-folder'))}${folderId}`);
    }

    makeBundle();
  };

  const selectFolder = async () => {
    // read from argv
    if (folderId) {
      folder = folderId;
      validateFolder(false);
      return;
    }

    const defaultFolder = process.cwd();
    folder = await ui.folderInput(_t('deploy.select-folder'), defaultFolder).catch();
    if (folder) {
      validateFolder(true);
    }
  };

  const projectSelected = () => {
    if (projectID) {
      console.log(`${chalk.bold(_t('deploy.selected-project'))} ${formatter.projectName(project)}`);
    }
    selectFolder().then();
  };

  const selectProject = async () => {
    // read from argv
    if (projectID) {
      project = helpers.resolveProject(projects, projectID);
      if (project) {
        projectSelected();
        return;
      }
      log.error(_t('deploy.no-project', {i: projectID}));
      return;
    }

    // no project. create a new one.
    if (projects.length === 0) {
      project = await config.api.createProject();
      projectSelected();
      return
    }

    // there is only 1 project. select it.
    if (projects.length === 1) {
      project = projects[0];
      projectSelected();
      return;
    }

    // select a project from list
    project = await ui.selectProject(_t('deploy.select-project'), projects).catch();
    if (project) {
      projectSelected();
      return;
    }

    log.info(_t('deploy.cancelled'));
  };

  projects = await config.api.getProjects();
  if (projects) {
    selectProject().then()
  }
};
