const assert = require('node:assert/strict');
const http = require('node:http');
const vscode = require('vscode');
const path = require('node:path');
const { buildSync } = require('esbuild');

suite('deeplocal-chat-adapter Extension Host', () => {
  let server;
  let baseUrl;
  let modelRequests = 0;

  suiteSetup(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/v1/models') {
        modelRequests += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'integration-model' }] }));
      } else {
        response.statusCode = 404;
        response.end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('deeplocal').update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('discovers and activates despite the unavailable default DeepLocal endpoint', async () => {
    const extension = vscode.extensions.getExtension('local-dev.deeplocal-chat-adapter');
    assert.ok(extension, 'extension should be discovered by its manifest');
    await extension.activate();
    assert.equal(extension.isActive, true);
    await vscode.workspace.getConfiguration('deeplocal').update(
      'baseUrl', 'http://127.0.0.1:1/v1', vscode.ConfigurationTarget.Global,
    );
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'deeplocal-chat-adapter.open', 'deeplocal-chat-adapter.newSession',
      'deeplocal-chat-adapter.refreshModels', 'deeplocal-chat-adapter.checkConnection',
    ]) assert.ok(commands.includes(command), `${command} should be registered`);
    assert.ok(vscode.extensions.all.find((candidate) => candidate.id === extension.id));
    // The command catches server errors and leaves the extension usable.
    await vscode.commands.executeCommand('deeplocal-chat-adapter.refreshModels');
    await vscode.workspace.getConfiguration('deeplocal').update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('deeplocal-chat-adapter.refreshModels');
    assert.ok(modelRequests > 0, 'extension should communicate with the fake OpenAI models endpoint');
    const models = await vscode.lm.selectChatModels({ vendor: 'deeplocal-chat-adapter' });
    assert.ok(models.some((model) => model.id === 'integration-model'), 'language model provider should expose discovered models');
    assert.ok(extension.packageJSON.contributes.views['deeplocal-chat-adapter-sidebar']
      .some((view) => view.id === 'deeplocal-chat-adapter.view'), 'webview view should be contributed');
    assert.ok(extension.packageJSON.contributes.viewsContainers.activitybar
      .some((container) => container.id === 'deeplocal-chat-adapter-sidebar'), 'container must use a stable contribution point');
    await vscode.commands.executeCommand('deeplocal-chat-adapter.open');
  });

  test('uses a single workspace folder automatically without selection', async () => {
    buildSync({ entryPoints: [path.join(__dirname, '../../src/agent-tools.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(__dirname, '../../out/single-workspace-tools.cjs') });
    const { invokeAgentTool } = require('../../out/single-workspace-tools.cjs');
    assert.equal(vscode.workspace.workspaceFolders.length, 1);
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'single.txt');
    await vscode.workspace.fs.writeFile(uri, Buffer.from('automatic single folder'));
    const result = await invokeAgentTool('single', 'read_file', '{"path":"single.txt"}');
    assert.equal(result.status, 'success');
    assert.equal(result.content, 'automatic single folder');
  });

  test('restores the latest request preview and selection without adding persisted fields', async () => {
    buildSync({ entryPoints: [path.join(__dirname, '../../src/chat-panel.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(__dirname, '../../out/session-preview-panel.cjs') });
    const { ChatPanel, workspaceIdentity } = require('../../out/session-preview-panel.cjs');
    const scope = workspaceIdentity();
    const key = `deeplocal.sessions.${scope}`;
    const activeKey = `deeplocal.activeSessionId.${scope}`;
    const latest = 'Latest request\n日本語 👩🏽‍💻 <img src=x onerror="synthetic57()"> & "quotes"';
    const values = new Map([[activeKey, 'saved'], [key, [{
      id: 'saved', title: 'Existing title', updatedAt: 1,
      history: [{ role: 'user', content: 'First request' }, { role: 'user', content: latest }],
      transcript: [{ role: 'You', text: 'First request' }, { role: 'You', text: latest }, { role: 'Tool', text: 'Unrelated result' }],
    }, { id: 'empty', title: 'New session', updatedAt: 0, history: [], transcript: [] }]]]);
    const memento = { get: (key, fallback) => values.get(key) ?? fallback,
      update: async (key, value) => { values.set(key, structuredClone(value)); } };
    const requests = [];
    const client = { listModels: async () => [{ id: 'session-test' }], modelInformation: () => ({ toolCalling: true }), cancel() {},
      streamChat: async function* (_id, request) { requests.push(request); yield { kind: 'text', value: 'Synthetic answer' }; } };
    const subscriptions = [];
    const panels = [];
    const mount = () => {
      const posts = [];
      let receive, dispose;
      const panel = new ChatPanel({ subscriptions, workspaceState: memento, globalState: memento }, client, { error() {} },
        { get: async () => undefined, set: async () => {}, clear: async () => {} });
      panel.resolveWebviewView({ onDidDispose: callback => { dispose = callback; }, webview: {
        cspSource: 'vscode-webview:', onDidReceiveMessage: callback => { receive = callback; },
        postMessage: message => { posts.push(message); return Promise.resolve(true); },
      } });
      panels.push(() => dispose());
      return { posts, send: message => receive(message) };
    };
    const waitFor = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Timed out waiting for session messages');
    };
    try {
      const first = mount();
      first.send({ type: 'ready' });
      await waitFor(() => first.posts.some(message => message.type === 'sessions'));
      const summary = first.posts.find(message => message.type === 'sessions');
      assert.equal(summary.activeSessionId, 'saved');
      assert.equal(summary.sessions[0].preview, latest);
      assert.equal(summary.sessions[0].title, 'Existing title');
      assert.equal(summary.sessions[1].preview, '');
      const followup = 'Follow-up request with extra context';
      first.send({ type: 'send', text: followup, model: 'session-test', useAgent: false });
      await waitFor(() => first.posts.some(message => message.type === 'assistantDone'));
      assert.equal(first.posts.filter(message => message.type === 'sessions').at(-1).sessions[0].preview, followup);
      assert.equal(requests[0].messages.filter(message => message.role === 'user').at(-1).content, followup);
      first.send({ type: 'switchSession', sessionId: 'empty' });
      await waitFor(() => values.get(activeKey) === 'empty');
      const restored = mount();
      restored.send({ type: 'ready' });
      await waitFor(() => restored.posts.some(message => message.type === 'sessions'));
      const restoredSummary = restored.posts.find(message => message.type === 'sessions');
      assert.equal(restoredSummary.activeSessionId, 'empty');
      assert.equal(restoredSummary.sessions.find(session => session.id === 'saved').preview, followup);
      assert.equal(values.get(key).find(session => session.id === 'saved').title, 'Existing title');
      assert.ok(values.get(key).every(session => !('preview' in session)));
    } finally {
      for (const dispose of panels) dispose();
      for (const subscription of subscriptions) subscription.dispose();
    }
  });
});
