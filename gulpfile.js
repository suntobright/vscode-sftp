const gulp = require('gulp');

const ts = require('gulp-typescript');
const typescript = require('typescript');
const sourcemaps = require('gulp-sourcemaps');
const del = require('del');
const vsce = require('vsce');
const nls = require('vscode-nls-dev');

const tsProject = ts.createProject('./tsconfig.json', { typescript });

// If all VS Code langaues are support you can use nls.coreLanguages
const languages = [{ id: 'zh-cn', folderName: 'zh-cn' }];

function clean(done) {
  del(['out/**', 'package.nls.*.json', '*.vsix']);
  done();
}

function compile(done) {
  tsProject.src()
    .pipe(sourcemaps.init())
    .pipe(tsProject()).js
    .pipe(nls.rewriteLocalizeCalls())
    .pipe(nls.createAdditionalLanguageFiles(languages, 'i18n', 'out'))
    .pipe(nls.bundleMetaDataFiles('i18n', 'out'))
    .pipe(nls.bundleLanguageFiles())
    .pipe(sourcemaps.write('../out', { includeContent: false, sourceRoot: '../src' }))
    .pipe(gulp.dest('out'));
    done();
}

function addI18n(done) {
  gulp.src(['package.nls.json'])
    .pipe(nls.createAdditionalLanguageFiles(languages, 'i18n'))
    .pipe(gulp.dest('.'));
    done();
}

function publish(done) {
  vsce.publish();
  done();
}

function package(done) {
  vsce.createVSIX();
  done();
}

gulp.task('clean', clean);
gulp.task('build', gulp.series(clean, compile, addI18n));
gulp.task('publish', gulp.series(clean, 'build', publish));
gulp.task('package', gulp.series(clean, 'build', package));
