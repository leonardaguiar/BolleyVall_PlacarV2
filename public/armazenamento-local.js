const ArmazenamentoLocal = (() => {
  'use strict';
  const DB = 'bolleyvall-local', STORE = 'estado', ID = 'principal';
  const CAMPOS = {
    'placar-volei-state-v1': 'placar',
    'sorteio-acompanhamento-v1': 'sorteio',
    'placar-encerrar-partida-v1': 'pedido'
  };
  const vazio = { id: ID, schemaVersion: 2, placar: null, sorteio: null, pedido: null, atualizadoEm: 0 };
  let banco = null, dado = { ...vazio }, prontoEstado = false, pendentes = [], fila = Promise.resolve(), canal = null;
  const ouvintes = new Set();

  function localGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function localSet(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (_) {} }
  function notificar(event) { ouvintes.forEach(fn => { try { fn(event); } catch (_) {} }); }
  function receber(event) {
    const campo = CAMPOS[event && event.key];
    if (!campo) return;
    const valor = event.newValue == null ? null : String(event.newValue);
    if (dado[campo] === valor) return;
    dado[campo] = valor;
    notificar({ key: event.key, newValue: valor, oldValue: event.oldValue || null, remote: true });
  }
  function publicar(event) {
    if (canal) { try { canal.postMessage(event); } catch (_) {} }
  }
  function abrir() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB indisponível'));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('A atualização do armazenamento está bloqueada'));
    });
  }
  function ler() {
    return new Promise((resolve, reject) => {
      const tx = banco.transaction(STORE, 'readonly'), req = tx.objectStore(STORE).get(ID);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  function gravarCompleto(record) {
    return new Promise((resolve, reject) => {
      const tx = banco.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  function gravarCampo(campo, valor) {
    return new Promise((resolve, reject) => {
      if (!banco) return reject(new Error('IndexedDB indisponível'));
      const tx = banco.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE), req = store.get(ID);
      req.onsuccess = () => {
        const record = req.result || { ...vazio };
        record.schemaVersion = 2; record[campo] = valor; record.atualizadoEm = Date.now();
        store.put(record);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  function lerLegado() {
    const record = { ...vazio, atualizadoEm: Date.now() };
    Object.keys(CAMPOS).forEach(key => { record[CAMPOS[key]] = localGet(key); });
    return record;
  }
  function fallback() {
    banco = null;
    Object.keys(CAMPOS).forEach(key => localSet(key, dado[CAMPOS[key]]));
    prontoEstado = true;
  }
  async function inicializar() {
    try {
      banco = await abrir();
      const salvo = await ler();
      dado = salvo && salvo.schemaVersion === 2 ? { ...vazio, ...salvo, id: ID, schemaVersion: 2 } : lerLegado();
      if (!salvo || salvo.schemaVersion !== 2) await gravarCompleto(dado);
      while (pendentes.length) {
        const lote = pendentes.splice(0);
        for (const op of lote) {
          await gravarCampo(op.campo, op.valor);
          dado[op.campo] = op.valor;
          publicar({ key: op.key, newValue: op.valor, oldValue: null });
        }
      }
      prontoEstado = true;
    } catch (_) {
      dado = lerLegado();
      pendentes.forEach(op => { dado[op.campo] = op.valor; });
      pendentes = [];
      fallback();
    }
  }
  function getItem(key) {
    const campo = CAMPOS[key];
    if (!campo || !prontoEstado || !banco) return localGet(key);
    return dado[campo];
  }
  function setItem(key, value) {
    const campo = CAMPOS[key], text = String(value);
    if (!campo) { localSet(key, text); return Promise.resolve(); }
    const oldValue = getItem(key); dado[campo] = text;
    localSet(key, text);
    if (!prontoEstado) {
      pendentes.push({ key, campo, valor: text }); localSet(key, text); return ready;
    }
    if (!banco) {
      localSet(key, text);
      if (canal) publicar({ key, newValue: text, oldValue });
      return Promise.resolve();
    }
    fila = fila.then(() => gravarCampo(campo, text))
      .then(() => publicar({ key, newValue: text, oldValue }))
      .catch(() => { fallback(); localSet(key, text); });
    return fila;
  }
  function removeItem(key) {
    const campo = CAMPOS[key];
    if (!campo) { localSet(key, null); return Promise.resolve(); }
    const oldValue = getItem(key); dado[campo] = null;
    localSet(key, null);
    if (!prontoEstado) {
      pendentes.push({ key, campo, valor: null }); localSet(key, null); return ready;
    }
    if (!banco) {
      localSet(key, null);
      if (canal) publicar({ key, newValue: null, oldValue });
      return Promise.resolve();
    }
    fila = fila.then(() => gravarCampo(campo, null))
      .then(() => publicar({ key, newValue: null, oldValue }))
      .catch(() => fallback());
    return fila;
  }
  function subscribe(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); }
  try {
    if ('BroadcastChannel' in window) {
      canal = new BroadcastChannel('bolleyvall-local-v2');
      canal.onmessage = event => receber(event.data);
    }
  } catch (_) {}
  window.addEventListener('storage', event => {
    if (CAMPOS[event.key]) receber(event);
  });
  const ready = inicializar();
  return { ready, getItem, setItem, removeItem, subscribe, flush: () => fila };
})();
window.ArmazenamentoLocal = ArmazenamentoLocal;
