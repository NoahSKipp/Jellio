import test from 'node:test';
import assert from 'node:assert/strict';
import { socketUrlWithApiKey, installSocketAuthFix } from '../../src/Jellio/Frontend/runtime/socketAuth.js';

test('socket URLs move api_key to ApiKey', () => {
  assert.equal(
    socketUrlWithApiKey('wss://jf.example/socket?api_key=abc&deviceId=d1'),
    'wss://jf.example/socket?deviceId=d1&ApiKey=abc',
  );
  assert.equal(socketUrlWithApiKey('ws://h:8096/jellyfin/socket?api_key=k'), 'ws://h:8096/jellyfin/socket?ApiKey=k');
});

test('other URLs and already fixed sockets stay as they are', () => {
  assert.equal(socketUrlWithApiKey('wss://jf.example/socket?ApiKey=abc'), 'wss://jf.example/socket?ApiKey=abc');
  assert.equal(socketUrlWithApiKey('wss://other.example/live?api_key=abc'), 'wss://other.example/live?api_key=abc');
  assert.equal(socketUrlWithApiKey('not a url'), 'not a url');
});

test('the patched constructor opens the rewritten URL once', () => {
  const opened = [];
  function FakeSocket(url) { opened.push(url); }
  FakeSocket.OPEN = 1;
  const scope = { WebSocket: FakeSocket, location: { href: 'https://jf.example/web/' } };
  installSocketAuthFix(scope);
  installSocketAuthFix(scope);
  new scope.WebSocket('wss://jf.example/socket?api_key=t');
  assert.deepEqual(opened, ['wss://jf.example/socket?ApiKey=t']);
  assert.equal(scope.WebSocket.OPEN, 1);
});
