var _ = require('lodash-node');
var delayAsync = require('delay-async');
var dropbox = require('dropbox');
var events = require('events');
var fs = require('fs');
var mkdirp = require('mkdirp');
var path = require('path');
var secret = require('@exponent/secret');

function getClient() {
  return new dropbox.Client({
    token: secret.dropbox._ccheeverTestAccessToken,
    key: secret.dropbox.appKey,
    secret: secret.dropbox.appSecret,
  });
}

async function syncLoop(client, cursor, destFolder, opts) {

  opts = opts || {};
  await mkdirp.promise(destFolder);
  var newCursor = await getAsync(client, cursor, destFolder, opts);
  var result;
  do {
    if (opts.verbose) {
      console.log("Polling for changes...");
    }
    result = await client.promise.pollForChanges(newCursor);
    if (!result) {
      if (opts.verbose) {
        console.error("Failure! No response from `pollForChanges`");
      }
      // TODO: Implement a smart back-off strategy
      result = {hasChanges: false, retryAfter: 30000};
    }
    if (!result.hasChanges && result.retryAfter) {
      await delayAsync(result.retryAfter * 1000);
    }
  } while (!result.hasChanges);

  return syncLoop(client, newCursor, destFolder, opts);

}


async function getAsync(client, cursor, destFolder, opts) {

  var delta = await client.promise.delta(cursor);
  if (!delta) {
    return cursor;
  }
  var newCursor = delta.cursorTag;
  var awaitables = [];
  for (var change of delta.changes) {
    awaitables.push(processChangeAsync(client, change, destFolder, opts));
  }
  await Promise.all(awaitables);

  return newCursor;

}

async function processChangeAsync(client, change, destFolder, opts) {
  opts = opts || {};
  var dest = path.join(destFolder, change.path);
  if (opts.verbose) {
    console.log("Syncing", dest, "...");
  }
  if (change.wasRemoved) {
    await fs.promise.unlink(change.path);
  } else if (change.stat.isFolder) {
    await mkdirp.promise(dest);
  } else if (change.stat.isFile) {
    // nesh*> yield fs.promise.writeFile('/tmp/image.jpg', yield c.promise.readFile('/dellie.jpg', {buffer:true}))
    var contentsBuffer = await client.promise.readFile(change.path, {buffer: true});
    await fs.promise.writeFile(dest, contentsBuffer);
  } else {
    throw new Error("I'm confused and don't know how to deal with this change", change);
  }
}



module.exports = {
  getAsync,
  getClient,
  processChangeAsync,
  secret,
  syncLoop,
};
