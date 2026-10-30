/**
 * Load the plugin's client bundle the way the DSH web shell does, and assert
 * that the factory registers and materializes without touching the DOM.
 *
 * The shell installs `window.__ModuleLoader__` and hands the bundle a
 * `require` that resolves the platform module table. This harness provides a
 * minimal `react` stub and a `locale` / `slots` / `conversation` service, then
 * drives the same registration path the browser uses.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

/** Minimal React stub: the plugin only calls createElement and the hooks. */
function createReactStub() {
  const hookState = [];
  let hookIndex = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const i = hookIndex++;
      if (!(i in hookState)) hookState[i] = typeof initial === 'function' ? initial() : initial;
      return [hookState[i], (next) => {
        hookState[i] = typeof next === 'function' ? next(hookState[i]) : next;
      }];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn
  };
  hookIndex = 0;
  return React;
}

/** Collect the registrations a plugin body makes. */
function createSlotRegistry() {
  const registered = [];
  const pending = [];
  return {
    registered,
    slots: {
      // The host calls the injected factory when the seat is claimed; the
      // registry keeps the factory so the test can drive it explicitly.
      inject: (_name, factory) => {
        pending.push(factory);
        return { dispose() {} };
      },
      register: (definition) => {
        registered.push(definition);
        return { dispose() {} };
      }
    },
    /** Run every deferred seat factory, the way claiming a seat does. */
    claim: () => {
      for (const factory of pending) factory();
      pending.length = 0;
    }
  };
}

/** Minimal DOM: the plugin installs one stylesheet and removes it on unload. */
function createDocumentStub() {
  const head = { children: [], appendChild(node) { this.children.push(node); } };
  return {
    head,
    createElement: (tag) => ({ tagName: tag, dataset: {}, style: {}, children: [], remove() {} }),
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {}
  };
}

/** Drive the bundle exactly as the browser does. */
function loadBundle() {
  const React = createReactStub();
  const registry = createSlotRegistry();
  const localeDictionaries = [];
  const effects = [];
  const documentStub = createDocumentStub();
  const services = {
    locale: {
      bind: () => (key, params) => {
        const dictionary = localeDictionaries[0] ?? {};
        const template = dictionary[key] ?? key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? ''));
      },
      register: (_ns, dictionaries) => {
        localeDictionaries.push(dictionaries.zh);
        return { dispose() {} };
      }
    },
    slots: registry.slots,
    conversation: {
      createDrafts: () => [],
      resolveDraftAttachments: () => [],
      releaseDraftAttachments: () => {}
    }
  };

  const ctx = {
    get: (name) => services[name],
    // The host runs an effect at mount and keeps its disposer for unmount.
    effect: (fn) => {
      effects.push(fn);
      const disposer = fn();
      return { dispose: () => { if (typeof disposer === 'function') disposer(); } };
    },
    locale: services.locale,
    slots: registry.slots
  };

  const registrations = [];
  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      }
    }
  };

  const source = readFileSync(clientPath, 'utf8');
  const factory = new Function('window', 'document', `${source}\nreturn window.__ModuleLoader__;`)(
    windowStub,
    documentStub
  );

  assert.equal(typeof factory, 'object', 'the bundle must register through __ModuleLoader__');
  assert.equal(registrations.length, 1, 'exactly one bundle registration');
  const registration = registrations[0];
  assert.equal(registration.id, 'dsh-plugin-live-shot', 'bundle id');

  // The factory receives a require that resolves 'react'.
  const module = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require: ${specifier}`);
  });

  assert.equal(typeof module.apply, 'function', 'the plugin body must expose apply');
  assert.ok(Array.isArray(module.inject), 'the plugin body must declare its inject list');
  assert.ok(module.inject.includes('slots'), 'the plugin needs the slots seat');
  assert.ok(module.inject.includes('locale'), 'the plugin needs the locale service');

  // Drive the effects the way the host does.
  module.apply(ctx);
  assert.ok(effects.length > 0, 'apply must register effects');

  // Claim the seats: the host runs the factory passed to slots.inject.
  registry.claim();

  return { registered: registry.registered, localeDictionaries, effects };
}

const { registered, localeDictionaries } = loadBundle();

// The composer button must land on the conversation.input.left seat.
const seat = registered.find((entry) => entry.name === 'conversation.input.left');
assert.ok(seat, 'the plugin must register the conversation.input.left seat');
assert.equal(seat.id, 'dsh-shot', 'seat id');
assert.equal(seat.order, 20, 'seat order');
assert.equal(typeof seat.inject, 'function', 'the seat injects the conversation accessor');
assert.equal(typeof seat.locale, 'string', 'the seat declares its copy namespace');

const injected = seat.inject();
assert.equal(typeof injected.getConversation, 'function', 'the seat exposes getConversation');

// Both dictionaries must carry exactly the same key set.
const zh = localeDictionaries[0];
assert.ok(zh && typeof zh === 'object', 'the zh dictionary must be registered');

// The critical copy keys must exist in both languages.
const required = [
  'button.label', 'panel.title', 'panel.composer', 'panel.composer.empty',
  'action.capture', 'action.paste', 'action.file', 'action.replace', 'action.add',
  'action.cancel', 'action.copy', 'action.undo', 'action.clear',
  'tool.rect', 'tool.ellipse', 'tool.arrow', 'tool.pen', 'tool.mosaic', 'tool.text',
  'field.color', 'field.weight', 'field.text',
  'error.noIntake', 'error.locked', 'error.noImage', 'error.capture', 'error.paste',
  'error.file', 'error.encode',
  'notice.replaced', 'notice.added', 'notice.copied'
];
for (const key of required) {
  assert.ok(key in zh, `the zh dictionary is missing ${key}`);
}

console.log('client bundle registers, materializes, and mounts the composer seat.');
console.log(`seat: ${seat.name} / ${seat.id} (order ${seat.order})`);
console.log(`dictionary keys checked: ${required.length}`);
