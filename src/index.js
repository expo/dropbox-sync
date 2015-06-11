var _ = require('lodash-node');
var delayAsync = require('delay-async');
var dropbox = require('dropbox');
var events = require('events');
var fs = require('fs');
var moment = require('moment-timezone');
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

function startSyncing(client, destFolder, opts) {
  opts = opts || {};
  var cursor = opts.cursor || null;
  delete opts.cursor;
  if (opts.verbose) {
    console.log("Created destination folder", destFolder);
  }

  var emitter = new events.EventEmitter();
  emitter._flags = {};
  emitter.stopSyncingAsync = function () {
    emitter._flags.stop = true;
    return new Promise((fulfill, reject) => {
      emitter.on('stopped', fulfill);
    });
  }

  syncLoop(client, cursor, destFolder, emitter, opts, emitter._flags).then(console.log, console.error);

  return emitter;

}

async function syncLoop(client, cursor, destFolder, emitter, opts, flags) {

  opts = opts || {};
  await mkdirp.promise(destFolder);
  if (flags.stop) {
    emitter.emit('stopped', cursor);
    return;
  }
  var newCursor = await getAsync(client, cursor, destFolder, emitter, opts);
  if (flags.stop) {
    emitter.emit('stopped', cursor);
    return;
  }
  var result;
  do {
    if (opts.verbose) {
      console.log("Polling for changes...");
    }
    result = await client.promise.pollForChanges(newCursor);
    if (opts.verbose) {
      console.log("Polled successfuly");
    }
    if (flags.stop) {
      emitter.emit('stopped', cursor);
      return;
    }
    if (!result) {
      console.error("Failure! No response from `pollForChanges`");
      // TODO: Implement a smart back-off strategy
      result = {hasChanges: false, retryAfter: 30000};
    }
    if (!result.hasChanges && result.retryAfter) {
      await delayAsync(result.retryAfter * 1000);
      if (flags.stop) {
        return;
      }
    }
  } while (!result.hasChanges && !flags.stop);


  if (flags.stop) {
    emitter.emit('stopped', cursor);
    return;
  }
  return syncLoop(client, newCursor, destFolder, emitter, opts, flags);

}


async function getAsync(client, cursor, destFolder, emitter, opts) {

  var delta = await client.promise.delta(cursor);
  if (!delta) {
    return cursor;
  }
  var newCursor = delta.cursorTag;
  var awaitables = [];
  for (var change of delta.changes) {
    emitter.emit('changeTo', change.path, change);
    awaitables.push(processChangeAsync(client, change, destFolder, emitter, opts));
  }
  try {
    await Promise.all(awaitables);
  } catch (e) {
    console.error("Error syncing (but will continue anyway):", e.message);
    emitter.emit('errorIgnored', e);
    // Wait 15 seconds
    await delayAsync(15000);
    // Return the old cursor since the sync failed
    return cursor;
  }

  //console.log("Synced as of", Date.now());
  emitter.emit('syncedToCursor', newCursor);
  return newCursor;

}

async function processChangeAsync(client, change, destFolder, emitter, opts) {
  opts = opts || {};
  var dest = path.join(destFolder, change.path);
  if (opts.verbose) {
    console.log("Syncing", dest, "...");
  }
  if (change.wasRemoved) {
    await fs.promise.unlink(dest);
    emitter.emit('didRemove', dest, change);
  } else if (change.stat.isFolder) {
    await mkdirp.promise(dest);
    emitter.emit('didMkdirp', dest, change);
  } else if (change.stat.isFile) {
    // nesh*> yield fs.promise.writeFile('/tmp/image.jpg', yield c.promise.readFile('/dellie.jpg', {buffer:true}))
    var contentsBuffer = await client.promise.readFile(change.path, {buffer: true});
    await fs.promise.writeFile(dest, contentsBuffer);
    emitter.emit('didWriteFile', dest, change);
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
  startSyncing,
  c: getClient(),
};
