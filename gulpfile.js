var gulp = require('gulp');
var babel = require('@exponent/gulp-babel');
var changed = require('gulp-changed');
var plumber = require('gulp-plumber');
var sourcemaps = require('gulp-sourcemaps');
var gutil = require('gulp-util');
var watch = require('gulp-watch');

var crayon = require('@ccheever/crayon');

babel.task(gulp, {
  paths: {
    src: ['src/**/*.js'],
  },
  babel: {
    stage: 0,
  },
});

gulp.task('default', ['babel-watch']);
gulp.task('build', ['babel']);
