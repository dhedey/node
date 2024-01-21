'use strict';
const common = require('../common');
const assert = require('assert');
const fork = require('child_process').fork;
const fixtures = require('../common/fixtures');
const http = require('http');

// Note to self: Normal debug has stopped printing debug messages...
// Not sure why. Instead let's implement our own:
// const debug = require('util').debuglog('test');
function debug(message) {
  console.log(message);
}

// NOTE:
// Putting the server in a separate process ensures that its
// responses are in a different event loop.
// This enables certain edge cases to happen which wouldn't otherwise be caught.
// I'm not actually 100% sure this is needed, but for now it makes sense
// to get the reproduction.
function runServerInChildProcessWithFreePort(listeningCallback, maxLifetimeMs) {
  const cp = fork(fixtures.path('child-process-run-tcp-server.js'));

  let messageIndex = 0;
  
  cp.on('message', function messageHandler(message) {
    switch (messageIndex++) {
      case 0:
        assert.strictEqual(message, "SERVER_LAUNCHED");
        break;
      case 1:
        assert.match(message, /SERVER_PORT: \d+/);
        const port = +message.split(" ")[1];
        listeningCallback(port);
        break;
      default:
        debug(message);
        break;
    }
  });
  setTimeout(() => {
    cp.kill();
  }, maxLifetimeMs);
}

const agent = new http.Agent({
  keepAlive: true,
  // NOTE:
  // > If maxSockets = 1 - second request gets "Error: socket hang up" immediately
  // > If maxSockets = 2, we also get this issue always
  // > But maxSockets isn't necessary to trigger this bug
  maxSockets: 1,
});

agent.on("free", (socket, options) => {
  if (socket.DEBUG_ATTEMPT) {
    debug(`CLIENT_AGENT_SOCKET_FREE: ${socket.DEBUG_ATTEMPT}`)
  }
})

function formatError(e) {
  let out = '';
  if (e instanceof AggregateError) {
    out += `AggregateError [${e.errors.length} SubError/s]`;
    if (e.message) {
      out += `- ${e.message}`;
    }
    for (let i = 0; i < e.errors.length; i++) {
      out += `\n> SubError ${i+1} of ${e.errors.length}:\n`
      out += formatError(e.errors[i]) 
    }
  }
  else {
    out += e;
    if (e.code) {
      out += ` (e.code: ${e.code})`;
    }
  }
  return out;
}

function getRequireSuccess(port, attemptMessage, onReceiveResponse) {
  return http.get({
    host: 'localhost',
    port: port,
    agent: agent,
    path: "/"
  }, function(res) {
    res.setEncoding('utf8');
    // According to ClientRequest, a data handler is mandatory
    res.on('data', common.mustCall((chunk) => {
      assert.strictEqual(chunk, "Hello, world!")
    }), 1);
    res.on('error', () => {
      assert.fail(`Response error ${attemptMessage}: ${formatError(e)}`);
    });
    res.on('end', () => {
      debug(`CLIENT_RESPONSE_END: ${attemptMessage}`)
      onReceiveResponse && onReceiveResponse();
    });
  })
  .on('socket', (socket) => {
    if (socket.DEBUG_ATTEMPT) {
      debug(`CLIENT_SOCKET_REUSED: ${socket.DEBUG_ATTEMPT} for ${attemptMessage}`)
      debug(`> With socket._readableState.endEmitted: ${socket._readableState.endEmitted}`)
      debug(`> With socket._readableState.ended: ${socket._readableState.ended}`)
      debug(`> With socket._writableState.writable: ${socket._writableState.writable}`)
      debug(`> With socket._writableState.ending: ${socket._writableState.ending}`)
      debug(`> With socket._writableState.ended: ${socket._writableState.ended}`)
      debug(`> With socket._writableState.finished: ${socket._writableState.finished}`)
    } else {
      socket.DEBUG_ATTEMPT = attemptMessage;
      socket.on("error", (e) => {
        assert.fail(`Socket error at ${attemptMessage}: ${formatError(e)}`);
      });
      socket.on("ready", () => {
        debug(`CLIENT_SOCKET_READY: ${attemptMessage}`);
      })
      socket.on("timeout", () => {
        debug(`CLIENT_SOCKET_TIMEOUT: ${attemptMessage}`);
      })
      socket.on("free", () => {
        debug(`CLIENT_SOCKET_FREE: ${attemptMessage}`);
      })
      socket.on("end", () => {
        debug(`CLIENT_SOCKET_END: ${attemptMessage}`);
      })
      socket.on("close", () => {
        debug(`CLIENT_SOCKET_CLOSED: ${attemptMessage}`);
      });
    }
  })
  .on('error', (e) => {
    assert.fail(`Request error at ${attemptMessage}: ${formatError(e)}`);
  });
}

// If the server lasts less long (e.g. 100ms) we get some
// ECONNRESET from the server being killed too early.
const MAX_SERVER_LIFETIME_MS = 500;

runServerInChildProcessWithFreePort(common.mustCall(function(port) {
  debug("CLIENT_PORT_RECEIVED_FROM_SERVER: " + port);

  // Any one of these can cause the error (randomly)
  // But the probability increases from ~50% to >90% by adding
  // a few more. We do this to ensure the test is repeatable.

  // This gives an error, with either:
  // * Request 1.1 reusing the socket from Request 2
  // * Request 2.1 reusing the socket from Request 1
  // Either of these appears to cause Error: socket hang up (e.code: ECONNRESET)
  // BECAUSE the server has already sent a FIN, which the client recognises, but
  // for some reason, still attempts to re-use the socket.

  getRequireSuccess(port, "Request 1", () => {
    getRequireSuccess(port, "Request 1.1");
  });
  getRequireSuccess(port, "Request 2", () => {
    getRequireSuccess(port, "Request 2.1");
  });

  // For debugging - uncomment this to force debug messages
  // to print even if the test succeeds.
  // setTimeout(() => {
  //   assert.fail("SUCCESS - TRIGGERING DEBUG MESSAGES");
  // }, 500);
}), MAX_SERVER_LIFETIME_MS);
