'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import SyncManager from '../../sync-manager.jsx';
import { readSharedSession, updateSharedSession } from '../../../lib/client/shared-session-storage.js';

const NETWORK_TIMEOUT_MS = 8000;

async function fetchJsonWithTimeout(url, options, requestsRef) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  requestsRef.current.add(controller);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    return { response, data };
  } finally {
    clearTimeout(timeout);
    requestsRef.current.delete(controller);
  }
}

function createDeviceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function elapsedSeconds(score) {
  const base = Number.isInteger(score.seconds) ? score.seconds : 0;
  if (!score.running || !score.startedAt) return base;
  const started = Date.parse(score.startedAt);
  return Number.isFinite(started) ? base + Math.max(0, Math.floor((Date.now() - started) / 1000)) : base;
}

function nextQueuedId(phase) {
  if (!phase.fila?.length) return null;
  if (phase.fila.every(item => item.jogou)) phase.fila.forEach(item => { item.jogou = false; });
  const index = phase.fila.findIndex(item => !item.jogou);
  return phase.fila.splice(index < 0 ? 0 : index, 1)[0]?.id ?? null;
}

function advanceLocalQueue(phase, winnerId, loserId) {
  phase.fila ||= [];
  phase.sequencia ||= {};
  phase.fila.push({ id: loserId, jogou: true });
  if (Number(phase.sequencia[winnerId] || 1) >= 2) {
    phase.fila.push({ id: winnerId, jogou: true });
    const first = nextQueuedId(phase);
    const second = nextQueuedId(phase);
    if (first !== null && second !== null) {
      phase.quadra = [first, second];
      phase.sequencia[first] = 1;
      phase.sequencia[second] = 1;
    }
  } else {
    const challenger = nextQueuedId(phase);
    if (challenger !== null) {
      phase.sequencia[winnerId] = Number(phase.sequencia[winnerId] || 1) + 1;
      phase.sequencia[challenger] = 1;
      phase.quadra = [winnerId, challenger];
    }
  }
}

function projectLocalCommand(session, type, data) {
  if (['match.correct', 'command.undo'].includes(type)) return null;
  const next = structuredClone(session);
  const state = next.state;
  const phase = next.plan?.fases?.[state?.faseAtual];
  const progress = state?.fases?.[state?.faseAtual];
  if (!phase || !progress) return null;
  const score = state.placar ||= {};
  score.a = Number.isInteger(score.a) && score.a >= 0 ? score.a : 0;
  score.b = Number.isInteger(score.b) && score.b >= 0 ? score.b : 0;
  const ongoing = phase.modo !== 'jogo' || progress.vencedor === null || progress.vencedor === undefined;

  if (type === 'score.adjust' && ongoing && ['a', 'b'].includes(data.side) && [-1, 1].includes(data.delta)) {
    score[data.side] = Math.max(0, score[data.side] + data.delta);
    if (!score.running) { score.running = true; score.startedAt = new Date().toISOString(); }
  } else if (type === 'timer.toggle' && ongoing) {
    if (score.running) {
      score.seconds = elapsedSeconds(score);
      score.running = false;
      score.startedAt = null;
    } else {
      score.running = true;
      score.startedAt = new Date().toISOString();
    }
  } else if (type === 'teams.swapSides' && ongoing && progress.quadra?.length === 2) {
    [progress.quadra[0], progress.quadra[1]] = [progress.quadra[1], progress.quadra[0]];
    [score.a, score.b] = [score.b, score.a];
    [score.colorA, score.colorB] = [score.colorB || '#E5484D', score.colorA || '#2F6FED'];
    [score.colorADim, score.colorBDim] = [score.colorBDim || '#A32A2E', score.colorADim || '#1E4CA8'];
    [score.nameA, score.nameB] = [score.nameB, score.nameA];
  } else if (['queue.skip', 'queue.togglePlayed'].includes(type) && ongoing && phase.modo === 'fila' && Number.isInteger(data.teamId)) {
    const item = progress.fila?.find(row => row.id === data.teamId);
    if (item && type === 'queue.togglePlayed') item.jogou = !item.jogou;
    else if (item) {
      progress.fila.splice(progress.fila.indexOf(item), 1);
      item.jogou = false;
      progress.fila.push(item);
    }
  } else if (type === 'match.finish' && ongoing && score.a !== score.b) {
    const winnerSide = score.a > score.b ? 1 : 2;
    const winnerId = progress.quadra?.[winnerSide - 1];
    const loserId = progress.quadra?.[winnerSide === 1 ? 1 : 0];
    const teamA = phase.times?.[progress.quadra?.[0]];
    const teamB = phase.times?.[progress.quadra?.[1]];
    const winner = phase.times?.[winnerId];
    const loser = phase.times?.[loserId];
    if (!Array.isArray(teamA) || !Array.isArray(teamB) || !Array.isArray(winner) || !Array.isArray(loser)) return null;
    const number = Number(progress.jogos || 0) + 1;
    progress.jogos = number;
    state.historico ||= [];
    state.historico.push({
      matchId: createDeviceId(), phaseIndex: state.faseAtual, titulo: phase.titulo, numero: number,
      vencedor: winner.join(' + '), perdedor: loser.join(' + '), vencedores: winner, perdedores: loser,
      teams: [teamA, teamB], scoreA: score.a, scoreB: score.b, winnerSide
    });
    if (phase.modo === 'jogo') {
      progress.vencedor = winnerId;
      if (state.faseAtual < next.plan.fases.length - 1) state.faseAtual += 1;
    } else {
      advanceLocalQueue(progress, winnerId, loserId);
    }
    state.placar = { ...score, a: 0, b: 0, seconds: 0, running: false, startedAt: null };
  } else {
    return null;
  }
  return next;
}

export default function SharedSessionPage() {
  const { id } = useParams();
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [accessToken, setAccessToken] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [controlMessage, setControlMessage] = useState('');
  const [controlBusy, setControlBusy] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const loadSessionRef = useRef(null);
  const connectionRef = useRef('connecting');
  const requestsRef = useRef(new Set());
  const sessionRef = useRef(null);
  const queueRef = useRef([]);
  const flushingRef = useRef(false);
  const remoteRevisionRef = useRef(0);
  const persistenceRef = useRef(Promise.resolve(true));
  const rejectQueueOnRefreshRef = useRef(false);

  const updateConnection = useCallback(status => {
    connectionRef.current = status;
    setConnection(status);
  }, []);

  function persistLocalState(nextSession = sessionRef.current, nextQueue = queueRef.current) {
    const pending = persistenceRef.current.then(() => updateSharedSession(id, { session: nextSession, queue: nextQueue }))
      .then(() => true, () => false);
    persistenceRef.current = pending;
    return pending;
  }

  function acceptRemoteSession(next) {
    if (Number(next.revision) < Number(remoteRevisionRef.current)) return;
    remoteRevisionRef.current = next.revision;
    const current = sessionRef.current;
    if (current && current.revision === next.revision && JSON.stringify(current) === JSON.stringify(next)) return;
    sessionRef.current = next;
    setSession(next);
    persistLocalState(next);
  }

  function reconcileRemoteSession(remote) {
    if (rejectQueueOnRefreshRef.current) {
      rejectQueueOnRefreshRef.current = false;
      queueRef.current = [];
      acceptRemoteSession(remote);
      return;
    }
    if (!queueRef.current.length) {
      acceptRemoteSession(remote);
      return;
    }
    if (!remote.control?.ownedByThisDevice || !['organizer', 'operator'].includes(remote.role) || remote.status !== 'active') {
      queueRef.current = [];
      acceptRemoteSession(remote);
      return;
    }
    remoteRevisionRef.current = remote.revision;
    const local = sessionRef.current;
    const merged = { ...remote, state: local?.state || remote.state };
    sessionRef.current = merged;
    setSession(merged);
    persistLocalState(merged);
    void flushQueuedCommands();
  }

  async function flushQueuedCommands() {
    if (flushingRef.current || !queueRef.current.length || !accessToken || !deviceId
        || connectionRef.current !== 'connected' || !navigator.onLine) return;
    flushingRef.current = true;
    try {
      while (queueRef.current.length && connectionRef.current === 'connected' && navigator.onLine) {
        if (!await persistenceRef.current) return;
        const command = queueRef.current[0];
        const sentRevision = remoteRevisionRef.current;
        let response, result;
        try {
          ({ response, data: result } = await fetchJsonWithTimeout(`/api/sessions/${id}/commands`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'X-Device-Id': deviceId, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedRevision: sentRevision, commandId: command.commandId, type: command.type, data: command.data }),
            cache: 'no-store'
          }, requestsRef));
        } catch {
          updateConnection(navigator.onLine ? 'reconnecting' : 'offline');
          return;
        }
        if (!response.ok) {
          if ([401, 403].includes(response.status)) {
            queueRef.current = [];
            persistLocalState(sessionRef.current, []);
            void loadSessionRef.current?.();
          } else if (response.status >= 400 && response.status < 500) {
            rejectQueueOnRefreshRef.current = response.status !== 409
              || !Number.isInteger(result.currentRevision)
              || result.currentRevision === sentRevision;
            void loadSessionRef.current?.();
          } else updateConnection('reconnecting');
          return;
        }
        remoteRevisionRef.current = result.revision;
        queueRef.current = queueRef.current.slice(1);
        if (queueRef.current.length) {
          const local = { ...sessionRef.current, revision: result.revision, control: sessionRef.current?.control };
          sessionRef.current = local;
          await persistLocalState(local);
        } else {
          acceptRemoteSession({ ...sessionRef.current, ...result, control: sessionRef.current?.control });
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }

  useEffect(() => {
    const token = decodeURIComponent(location.hash.slice(1));
    if (!token) { setError('Este link não contém um token de acesso válido.'); return; }
    const storageKey = `bolleyvall-device:${id}`;
    let localDeviceId = sessionStorage.getItem(storageKey);
    if (!localDeviceId) {
      localDeviceId = createDeviceId();
      sessionStorage.setItem(storageKey, localDeviceId);
    }
    setDeviceId(localDeviceId);
    setAccessToken(token);
    let active = true;
    let loaded = false;
    let accessRejected = false;
    let inFlight = false;
    let controller = null;

    void readSharedSession(id).then(saved => {
      if (!active || !saved) return;
      queueRef.current = Array.isArray(saved.queue) ? saved.queue : [];
      if (saved.session) {
        sessionRef.current = saved.session;
        remoteRevisionRef.current = saved.session.revision;
        setSession(saved.session);
        if (!accessRejected) setError('');
      }
      if (!navigator.onLine) updateConnection('offline');
    }).catch(() => {});

    async function loadSession() {
      if (!active || inFlight) return;
      if (!navigator.onLine) {
        updateConnection('offline');
        return;
      }
      inFlight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`/api/sessions/${id}`, {
          headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': localDeviceId },
          cache: 'no-store',
          signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok) {
          const failure = new Error(data.error || 'Não foi possível carregar a sala.');
          failure.status = response.status;
          throw failure;
        }
        if (!active) return;
        reconcileRemoteSession(data);
        setError('');
        const wasDisconnected = connectionRef.current !== 'connected';
        updateConnection('connected');
        if (wasDisconnected) {
          setControlMessage('');
        }
        setLastUpdatedAt(Date.now());
        void flushQueuedCommands();
        loaded = true;
      } catch (cause) {
        if (!active) return;
        if (!loaded && cause.status && [401, 404].includes(cause.status)) {
          accessRejected = true;
          setError(cause.message);
        } else if (!loaded && !sessionRef.current) {
          setError(cause.name === 'AbortError'
            ? 'A conexão demorou mais que o esperado. Confira se o link usa o endereço do computador que está executando o servidor.'
            : cause.message);
        }
        updateConnection(navigator.onLine ? 'reconnecting' : 'offline');
      } finally {
        clearTimeout(timeout);
        inFlight = false;
      }
    }

    loadSessionRef.current = loadSession;
    loadSession();
    const interval = setInterval(loadSession, 2000);
    const onOffline = () => {
      updateConnection('offline');
      controller?.abort();
      requestsRef.current.forEach(request => request.abort());
    };
    const onOnline = () => {
      updateConnection('reconnecting');
      loadSession();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      controller?.abort();
      requestsRef.current.forEach(request => request.abort());
    };
  }, [id, updateConnection]);

  useEffect(() => {
    if (!session?.control?.ownedByThisDevice || !accessToken || !deviceId || session.status !== 'active') return undefined;
    let inFlight = false;
    const renew = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      if (!navigator.onLine) {
        updateConnection('offline');
        return;
      }
      inFlight = true;
      try {
        const { response } = await fetchJsonWithTimeout(`/api/sessions/${id}/control`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'X-Device-Id': deviceId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'renew' }),
          cache: 'no-store'
        }, requestsRef);
        if (!response.ok) {
          void loadSessionRef.current?.();
        }
      } catch {
        updateConnection(navigator.onLine ? 'reconnecting' : 'offline');
      } finally { inFlight = false; }
    };
    const renewWhenActive = () => {
      if (document.visibilityState === 'visible') renew();
    };
    renew();
    const timer = setInterval(renew, 10000);
    document.addEventListener('visibilitychange', renewWhenActive);
    window.addEventListener('online', renewWhenActive);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', renewWhenActive);
      window.removeEventListener('online', renewWhenActive);
    };
  }, [accessToken, deviceId, id, session?.control?.ownedByThisDevice, session?.status, updateConnection]);

  async function controlAction(action) {
    if (controlBusy) return;
    if (connectionRef.current !== 'connected' || !navigator.onLine) {
      updateConnection(navigator.onLine ? 'reconnecting' : 'offline');
      return;
    }
    if (!accessToken || !deviceId) {
      setControlMessage('Não foi possível identificar este aparelho. Recarregue a sala e tente novamente.');
      return;
    }
    setControlBusy(true);
    setControlMessage('');
    try {
      const { response, data } = await fetchJsonWithTimeout(`/api/sessions/${id}/control`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'X-Device-Id': deviceId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        cache: 'no-store'
      }, requestsRef);
      if (!response.ok) throw new Error(data.error || 'Não foi possível alterar o controle.');
      setControlMessage('');

      updateConnection('reconnecting');
      void loadSessionRef.current?.();
    } catch (cause) {
      if (cause.name === 'AbortError' || !navigator.onLine || cause instanceof TypeError) {
        updateConnection(navigator.onLine ? 'reconnecting' : 'offline');
        void loadSessionRef.current?.();
      } else {
        setControlMessage(cause.message);
        await loadSessionRef.current?.();
      }
    } finally { setControlBusy(false); }
  }

  const phaseIndex = session?.state?.faseAtual ?? 0;
  const phase = session?.plan?.fases?.[phaseIndex];
  const progress = session?.state?.fases?.[phaseIndex];
  const teams = progress?.quadra?.map(teamId => phase?.times?.[teamId]?.join(' + ')) || [];
  const score = session?.state?.placar || {};
  const baseSeconds = Number.isInteger(score.seconds) ? score.seconds : 0;
  const startedAt = score.running && score.startedAt ? Date.parse(score.startedAt) : NaN;
  const seconds = baseSeconds + (Number.isFinite(startedAt) ? Math.max(0, Math.floor((clockNow - startedAt) / 1000)) : 0);
  const minutesText = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secondsText = String(seconds % 60).padStart(2, '0');
  const queue = (progress?.fila || []).slice(0, 2).map(item => ({
    id: item.id,
    name: phase?.times?.[item.id]?.join(' + ') || `Time ${item.id + 1}`,
    played: !!item.jogou
  }));
  const lastMatch = session?.state?.historico?.at(-1);
  const updatedTime = lastUpdatedAt
    ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(lastUpdatedAt)
    : '—';
  const scoreboardStyle = {
    '--team-a': score.colorA || '#2F6FED',
    '--team-a-dim': score.colorADim || '#1E4CA8',
    '--team-b': score.colorB || '#E5484D',
    '--team-b-dim': score.colorBDim || '#A32A2E'
  };
  const control = session?.control;
  const hasLease = session?.status === 'active'
    && control?.ownedByThisDevice
    && ['organizer', 'operator'].includes(session.role);
  const canControl = hasLease
    && !controlBusy
    && !(phase?.modo === 'jogo' && progress?.vencedor !== null && progress?.vencedor !== undefined);
  const canOrganize = hasLease && connection === 'connected' && session.role === 'organizer';
  const canCorrectLatest = canOrganize && session?.lastCommand?.type === 'match.finish'
    && lastMatch?.matchId === session?.lastCommand?.matchId;

  useEffect(() => {
    if (!score.running) return undefined;
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [score.running, score.startedAt]);

  useEffect(() => {
    let active = true;
    let wakeLock = null;
    let requesting = false;
    const requestWakeLock = async () => {
      if (!active || requesting || document.visibilityState !== 'visible' || !('wakeLock' in navigator) || (wakeLock && !wakeLock.released)) return;
      requesting = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (!active) {
          await lock.release();
          return;
        }
        wakeLock = lock;
        lock.addEventListener('release', () => {
          if (wakeLock === lock) {
            wakeLock = null;
            if (active && document.visibilityState === 'visible') setTimeout(() => void requestWakeLock(), 0);
          }
        }, { once: true });
      } catch { /* API indisponível ou bloqueada pelo navegador/dispositivo */ }
      finally { requesting = false; }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void requestWakeLock();
    };
    void requestWakeLock();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (wakeLock && !wakeLock.released) void wakeLock.release();
    };
  }, []);

  async function sendCommand(type, data = {}) {
    const current = sessionRef.current;
    if (!hasLease || !accessToken || !deviceId) return;
    if (!current?.control?.ownedByThisDevice || current.status !== 'active') {
      return;
    }
    if (type === 'match.finish' && current.state?.placar?.a === current.state?.placar?.b) return;
    const command = { commandId: createDeviceId(), type, data };
    queueRef.current = [...queueRef.current, command];
    const projected = projectLocalCommand(current, type, data);
    let saved;
    if (projected) {
      projected.revision = remoteRevisionRef.current;
      sessionRef.current = projected;
      setSession(projected);
      saved = persistLocalState(projected, queueRef.current);
    } else {
      saved = persistLocalState(current, queueRef.current);
    }
    if (await saved && connectionRef.current === 'connected' && navigator.onLine) void flushQueuedCommands();
  }

  async function finishCompetition() {
    if (!canOrganize) return;
    setControlBusy(true);
    setControlMessage('');
    try {
      const { response, data: result } = await fetchJsonWithTimeout(`/api/sessions/${id}/finish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'X-Device-Id': deviceId },
        cache: 'no-store'
      }, requestsRef);
      if (!response.ok) throw new Error(result.error || 'Não foi possível encerrar a competição.');
      setControlMessage('');

      updateConnection('reconnecting');
      void loadSessionRef.current?.();
    } catch (cause) {
      if (cause.name === 'AbortError' || !navigator.onLine || cause instanceof TypeError) {
        updateConnection(navigator.onLine ? 'reconnecting' : 'offline');
        void loadSessionRef.current?.();
      } else {
        setControlMessage(cause.message);
        await loadSessionRef.current?.();
      }
    } finally { setControlBusy(false); }
  }

  function finishCurrentMatch() {
    if (canControl) setPendingConfirmation({ type: 'match.finish', message: 'Encerrar a partida? O time com mais pontos será registrado como vencedor.' });
  }

  function correctLatestResult() {
    if (canCorrectLatest) setPendingConfirmation({ type: 'match.correct', message: 'Corrigir o último resultado e trocar o vencedor registrado?' });
  }

  function undoLastAction() {
    if (canOrganize) setPendingConfirmation({ type: 'command.undo', message: 'Desfazer a última ação registrada na sala?' });
  }

  function confirmPendingAction() {
    const action = pendingConfirmation?.type;
    setPendingConfirmation(null);
    if (action === 'competition.finish') finishCompetition();
    else if (action) sendCommand(action);
  }
  const controlLabel = !control
    ? 'Verificando controle…'
    : control.status !== 'active'
      ? 'Competição encerrada · somente visualização'
      : control.ownedByThisDevice
        ? 'Controle ativo neste aparelho'

        : control.reservedForThisAccess
          ? 'Controle reservado para este link de operador · assuma para vincular este aparelho'
          : control.held
            ? control.takeoverAvailable
              ? `Sem comunicação há 1 minuto · controle pode ser assumido (${control.holderRole === 'operator' ? 'operador' : 'organizador'})`
              : `Controle em uso por ${control.holderRole === 'operator' ? 'operador' : 'organizador'} em outro aparelho`
            : 'Controle livre';

  if (error || !session) {
    return <main className="shared-page">
      <header className="shared-header"><div><small>BOLLEYVALL · SALA COMPARTILHADA</small><h1>Placar e sorteio</h1></div></header>
      <section className={`shared-card${error ? ' shared-error' : ''}`} role={error ? 'alert' : 'status'}>
        {error || 'Carregando sala…'}
      </section>
      {error && <div className="shared-error-actions">
        <a className="shared-back-button" href="/">Voltar ao placar</a>
      </div>}
    </main>;
  }

  return <div id="stage" className="shared-viewer" style={scoreboardStyle}>
    <header>
      <div className="name-block a"><div className="team-name a">{teams[0] || score.nameA || 'Time 1'}</div></div>
      <div className="mid-col">
        <button className={`timer${score.running ? ' running' : ''}`} type="button" aria-label="Cronômetro" disabled={!canControl} onClick={() => sendCommand('timer.toggle')}>
          {minutesText}:{secondsText}
        </button>
        <a className="draw-btn" href={`/sortear.html?visualizador=${id}#visualizador=${encodeURIComponent(accessToken)}`}>Sortear time</a>
      </div>
      <div className="name-block b"><div className="team-name b">{teams[1] || score.nameB || 'Time 2'}</div></div>
    </header>
    <main>
      <div className="panel a">
        <div className="stepper">
          <button className="up" type="button" aria-label="Adicionar ponto ao Time 1" disabled={!canControl} onClick={() => sendCommand('score.adjust', { side: 'a', delta: 1 })}>▲</button>
          <button className="down" type="button" aria-label="Retirar ponto do Time 1" disabled={!canControl} onClick={() => sendCommand('score.adjust', { side: 'a', delta: -1 })}>▼</button>
        </div>
        <button className="score shared-score-button" type="button" aria-label="Adicionar ponto ao Time 1" disabled={!canControl} onClick={() => sendCommand('score.adjust', { side: 'a', delta: 1 })}>{score.a ?? 0}</button>
      </div>
      <div className="divider" />
      {canControl
        ? <button className="reset-btn" type="button" onClick={finishCurrentMatch}>Encerrar partida</button>
        : <button className="reset-btn viewer-mode" type="button" disabled>{session.role === 'organizer' ? 'Modo Organizador' : session.role === 'operator' ? 'Modo Operador' : 'Modo Visualizador'}</button>}
      <button className="swap-sides-btn" type="button" aria-label="Trocar os lados dos times" title="Trocar os lados dos times" disabled={!canControl} onClick={() => sendCommand('teams.swapSides')}>
        ⇄
      </button>
      <div className="panel b">
        <div className="stepper">
          <button className="up" type="button" aria-label="Adicionar ponto ao Time 2" disabled={!canControl} onClick={() => sendCommand('score.adjust', { side: 'b', delta: 1 })}>▲</button>
          <button className="down" type="button" aria-label="Retirar ponto do Time 2" disabled={!canControl} onClick={() => sendCommand('score.adjust', { side: 'b', delta: -1 })}>▼</button>
        </div>
        <button className="score shared-score-button" type="button" aria-label="Adicionar ponto ao Time 2" disabled={!canControl} onClick={() => sendCommand('score.adjust', { side: 'b', delta: 1 })}>{score.b ?? 0}</button>
      </div>

      <details className="shared-progress">
        <summary>Próximos 2 da fila</summary>
        <div className="shared-progress-content">
          <section>
            <h2>Fila</h2>
            {queue.length ? <ol>{queue.map((team, index) => <li key={`${team.name}-${index}`}>{team.name}{team.played ? ' · já jogou' : ''}{canControl && phase?.modo === 'fila' && <><button className="shared-inline-action" type="button" onClick={() => sendCommand('queue.togglePlayed', { teamId: team.id })}>{team.played ? 'Desmarcar' : 'Já jogou'}</button><button className="shared-inline-action" type="button" onClick={() => sendCommand('queue.skip', { teamId: team.id })}>Pular</button></>}</li>)}</ol> : <p>Sem times aguardando.</p>}
          </section>
          {session.role === 'organizer' && <section className="shared-organizer-actions">
            <h2>Controle e ações</h2>
            <p>{controlLabel}</p>
            {session.status === 'active' && (!control?.held || (control?.takeoverAvailable && !control?.ownedByThisDevice)) && (
              <button className="shared-inline-action" type="button" disabled={connection !== 'connected' || controlBusy || !accessToken || !deviceId} onClick={() => controlAction('claim')}>Assumir controle</button>
            )}
            {session.status === 'active' && control?.held && !control?.ownedByThisDevice && (
              <button className="shared-inline-action" type="button" disabled={connection !== 'connected' || controlBusy} onClick={() => controlAction('recover')}>Recuperar controle</button>
            )}
            {session.status === 'active' && control?.held && (
              <button className="shared-inline-action" type="button" disabled={connection !== 'connected' || controlBusy || !control.operatorAvailable} onClick={() => controlAction('transfer')}>Transferir para operador</button>
            )}
            {canOrganize && session.undoAvailable && <button className="shared-inline-action" type="button" onClick={undoLastAction}>Desfazer</button>}
            {canCorrectLatest && <button className="shared-inline-action" type="button" onClick={correctLatestResult}>Corrigir último resultado</button>}
            {canOrganize && <button className="shared-inline-action" type="button" disabled={controlBusy} onClick={() => setPendingConfirmation({ type: 'competition.finish', message: 'Encerrar a competição? A sala continuará disponível somente para visualização.' })}>Encerrar competição</button>}
          </section>}
        </div>
      </details>
    </main>

    <section className={`shared-control${session.role === 'organizer' ? ' organizer-compact' : ''}`} aria-label="Controle da sala">
      {session.role === 'organizer' ? <>
        <span className="shared-control-state">Organizador</span>
        {session.status === 'active' && control?.ownedByThisDevice && (
          <button type="button" disabled={connection !== 'connected' || controlBusy} onClick={() => controlAction('release')}>Liberar controle</button>
        )}
        <SyncManager roomId={id} autoOpen triggerClassName="shared-links-launch" />
      </> : <>
        <span className="shared-control-state">{controlLabel}</span>
        {session.status === 'active' && session.role === 'operator' && (!control?.held || (control?.takeoverAvailable && !control?.reservedForThisAccess)) && (
          <button type="button" disabled={connection !== 'connected' || controlBusy || !accessToken || !deviceId} onClick={() => controlAction('claim')}>Assumir controle</button>
        )}
        {session.status === 'active' && session.role === 'operator' && control?.reservedForThisAccess && (
          <button type="button" disabled={connection !== 'connected' || controlBusy || !accessToken || !deviceId} onClick={() => controlAction('claim')}>Vincular este aparelho</button>
        )}
        {session.status === 'active' && control?.ownedByThisDevice && (
          <button type="button" disabled={connection !== 'connected' || controlBusy} onClick={() => controlAction('release')}>Liberar controle</button>
        )}
        {session.role === 'viewer' && <span className="shared-control-note">Visualizador não pode assumir o controle.</span>}
      </>}
      {controlMessage && <span className="shared-control-message" role="status">{controlMessage}</span>}
    </section>

    <footer className="shared-status">
      <span className="shared-copy-note">Esta cópia foi criada quando a sincronização foi ativada.</span>
      <span className={`shared-connection ${connection}`}><i aria-hidden="true" />{connection === 'connected' ? 'Conectado' : connection === 'connecting' ? 'Conectando…' : connection === 'offline' ? 'Sem conexão' : 'Reconectando…'}</span>
      <span>Atualizado {updatedTime}</span>
      {session.status === 'finished' && <span>Competição encerrada · somente visualização</span>}
      <span>Revisão {session.revision}</span>
      <span className="shared-status-label">Sala compartilhada</span>
    </footer>
    {pendingConfirmation && <div className="shared-confirm-overlay" role="presentation">
      <section className="shared-confirm-dialog" role="alertdialog" aria-modal="true" aria-label="Confirmar ação">
        <p>{pendingConfirmation.message}</p>
        <div>
          <button type="button" onClick={() => setPendingConfirmation(null)}>Cancelar</button>
          <button type="button" className="shared-confirm-primary" onClick={confirmPendingAction}>Confirmar</button>
        </div>
      </section>
    </div>}
  </div>;
}
