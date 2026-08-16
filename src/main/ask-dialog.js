'use strict';

/**
 * Ask-each-time decision provider.
 *
 * When the filter finds a hit, the proxy waits while this shows a small
 * always-on-top dialog: which agent, which keyword, the surrounding context
 * (span highlighted), and Allow / Deny / "Allow all this session" actions.
 *
 * Fail-closed by default: if the dialog times out or no window can be shown,
 * the request is denied (governance default) — configurable via settings.
 */

const path = require('path');

let pending = new Map(); // id -> { resolve }

function createAskProvider({ getWindow, logger = console, onLog }) {
  let dialogWindow = null;

  function showDialog() {
    if (dialogWindow && !dialogWindow.isDestroyed()) {
      dialogWindow.show();
      dialogWindow.focus();
      return dialogWindow;
    }
    const { BrowserWindow } = require('electron');
    dialogWindow = new BrowserWindow({
      width: 520,
      height: 430,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: 'itqan Shield — confirm',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    dialogWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ask.html'));
    dialogWindow.on('closed', () => {
      dialogWindow = null;
    });
    return dialogWindow;
  }

  return {
    async askForDecision({ agent, span, spans, prompt, timeoutMs }) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const win = showDialog();

      const decision = new Promise((resolve) => {
        pending.set(id, resolve);
      });

      // Timeout → deny (fail-closed), unless the user answered first.
      const timer = setTimeout(() => {
        const resolve = pending.get(id);
        if (resolve) {
          pending.delete(id);
          resolve({ allow: false, session: false, timedOut: true });
        }
      }, timeoutMs || 30000);

      const cleanup = () => {
        clearTimeout(timer);
        pending.delete(id);
      };

      try {
        win.webContents.send('ask:prompt', {
          id,
          agent: { id: agent.id, name: agent.name },
          span,
          spans,
          promptPreview: prompt.slice(0, 2000),
        });
      } catch (err) {
        logger.warn(`[ask] dialog send failed: ${err.message}`);
        cleanup();
        return { allow: false, session: false };
      }

      const result = await decision;
      cleanup();
      try {
        onLog && onLog({
          ts: new Date().toISOString(),
          agent: agent.id,
          keyword: span.label,
          category: span.category,
          decision: result.allow ? 'allow' : result.timedOut ? 'timeout-deny' : 'deny',
        });
      } catch {
        /* ignore */
      }
      return result;
    },

    /** Called from the renderer via IPC when the user clicks a button. */
    resolveDecision(id, verdict) {
      const resolve = pending.get(id);
      if (!resolve) return false;
      pending.delete(id);
      resolve(verdict);
      return true;
    },
  };
}

module.exports = { createAskProvider };
