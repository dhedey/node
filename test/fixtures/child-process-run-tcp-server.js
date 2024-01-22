'use strict';

// NOTE: This file was purposefully constructed to run as a child process
// of test-http-agent-fin-handling.js and should be considered a partner
// of this test

const net = require('net');

function plaintextHttpResponse(text) {
  // Important that there's no "Connection: close" here, else the
  // client socket is correctly not re-used.
  return "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/plain\r\n" +
    `Content-Length: ${text.length}\r\n` +
    "\r\n" +
    `${text}`
}

function sendToParent(message) {
  process.send(message, undefined, { swallowErrors: true }, () => {});
}

let socketCount = 0;

// Creates a TCP server (from e.g. test-http-1.0.js)
const server = net.createServer({
  // allowHalfOpen setting seems irrelevant
}, function(socket) {
  let allReceivedClientData = '';
  let finHasBeenSent = false;
  let socketNumber = ++socketCount;
  process.send(`SERVER_SOCKET_OPEN: ${socketNumber}`);

  socket.setEncoding('utf8');
  socket.on('data', function(chunk) {
    allReceivedClientData += chunk;
    if (finHasBeenSent) {
      // This isn't actually necessary to trigger the issues
      // But is likely behaviour of a server receiving traffic
      // after it sent a FIN.
      sendToParent(`SERVER_SEND_RESET: ${socketNumber}`);
      socket.resetAndDestroy();
      return;
    }
    // Assume it's a GET request...
    // Therefore \r\n\r\n marks the end of the request
    const isEndOfRequest = allReceivedClientData.endsWith("\r\n\r\n");
    if (isEndOfRequest) {
      sendToParent(`SERVER_SEND_FIN: ${socketNumber}`);
      socket.write(plaintextHttpResponse('Hello, world!'));

      // Even if the request comes with Connection: Keep-Alive,
      // we ignore it and just end the connection/socket.
      finHasBeenSent = true;
      socket.end();
    }
  });
  socket.on('end', function() {
    sendToParent(`SERVER_SOCKET_CLOSE: ${socketNumber}`);
  });
  socket.on('error', function() {
    sendToParent(`SERVER_SOCKET_ERROR: ${socketNumber}`);
  })
});
server.listen(0, function() {
  // When we start listening, send the port to the parent:
  sendToParent("SERVER_PORT: " + this.address().port);
});
sendToParent("SERVER_LAUNCHED");
