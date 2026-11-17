'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const STORAGE_KEY = 'bolleyvall-sync-manager-v1';
const ROLES = [
  ['viewer', 'Visualizador'],
  ['operator', 'Operador']
];

function createDeviceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function deviceIdFor(sessionId) {
  const key = `bolleyvall-device:${sessionId}`;
  let deviceId = sessionStorage.getItem(key);
  if (!deviceId) {
    deviceId = createDeviceId();
    sessionStorage.setItem(key, deviceId);
  }
  return deviceId;
}

function readLocalDraw() {
  try {
    const raw = localStorage.getItem('sorteio-acompanhamento-v1');
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved?.plano || !saved?.estado) return null;
    const placar = JSON.parse(localStorage.getItem('placar-volei-state-v1') || 'null');
    const { desfazer, ...estado } = saved.estado;
    return { plan: saved.plano, state: { ...estado, placar } };
  } catch { return null; }
}

export default function SyncManager({ roomId = null, autoOpen = false, triggerClassName = '' } = {}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [links, setLinks] = useState({});
  const [archives, setArchives] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [hasDraw, setHasDraw] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      const matchesRoom = !roomId || saved?.id === roomId;
      setArchives(saved?.archives || []);
      if (roomId && !matchesRoom) { setSession(null); setLinks({}); setOpen(false); }
      if (saved?.id && saved?.token && matchesRoom) {
        setOpen(!!autoOpen && new URLSearchParams(location.search).get('semModal') !== '1');
        setSession(saved);
        setLinks(saved.links || {});
        fetch(`/api/sessions/${saved.id}`, { headers: { Authorization: `Bearer ${saved.token}`, 'X-Device-Id': deviceIdFor(saved.id) }, cache: 'no-store' })
          .then(async response => response.ok ? response.json() : null)
          .then(data => {
            if (!data?.shareOrigin) return;
            const refreshed = { ...saved, status: data.status, organizerUrl: `${data.shareOrigin}/s/${saved.id}#${saved.token}` };
            const refreshedLinks = Object.fromEntries(Object.entries(saved.links || {}).map(([role, link]) => {
              try {
                const oldUrl = new URL(link);
                return [role, `${data.shareOrigin}${oldUrl.pathname}${oldUrl.hash}`];
              } catch { return [role, link]; }
            }));
            setSession(refreshed);
            setLinks(refreshedLinks);
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...refreshed, links: refreshedLinks }));
          })
          .catch(() => {});
      }
    } catch {}
    setHasDraw(!!readLocalDraw());
  }, [roomId, autoOpen]);

  useEffect(() => {
    if (roomId || !session?.id || !session?.token || session.status !== 'active') return undefined;
    const deviceId = deviceIdFor(session.id);
    let inFlight = false;
    const renew = async () => {
      if (inFlight || document.visibilityState !== 'visible' || !navigator.onLine) return;
      inFlight = true;
      try {
        await fetch(`/api/sessions/${session.id}/control`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}`, 'X-Device-Id': deviceId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'renew' }),
          cache: 'no-store'
        });
      } catch {}
      finally { inFlight = false; }
    };
    const timer = setInterval(renew, 10000);
    return () => clearInterval(timer);
  }, [roomId, session?.id, session?.status, session?.token]);

  function saveSession(next, nextLinks = links, nextArchives = archives) {
    setSession(next);
    setLinks(nextLinks);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, links: nextLinks, archives: nextArchives }));
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
        ...options.headers
      }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
    return data;
  }

  async function activate() {
    const snapshot = readLocalDraw();
    if (!snapshot) { setMessage('Abra um sorteio com andamento antes de ativar a sincronização.'); return; }
    setBusy(true); setMessage('');
    try {
      const deviceId = createDeviceId();
      const created = await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId }, body: JSON.stringify(snapshot)
      });
      const data = await created.json();
      if (!created.ok) throw new Error(data.error || 'Não foi possível ativar a sala.');
      sessionStorage.setItem(`bolleyvall-device:${data.id}`, deviceId);
      const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      const nextArchives = previous?.id && previous.status === 'finished'
        ? [...(previous.archives || []), previous]
        : archives;
      const shareOrigin = data.shareOrigin || location.origin;
      const next = { id: data.id, token: data.accessToken, status: data.status, sourcePlanId: snapshot.plan.id, organizerUrl: `${shareOrigin}/s/${data.id}#${data.accessToken}` };
      setSession(next); setLinks({}); setArchives(nextArchives);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, links: {}, archives: nextArchives }));
      let issued = {};
      for (const [role] of ROLES) {
        const link = await fetch(`/api/sessions/${data.id}/access`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.accessToken}` },
          body: JSON.stringify({ role })
        });
        const value = await link.json();
        if (!link.ok) throw new Error(value.error || 'A sala foi criada, mas não foi possível emitir todos os links.');
        issued[role] = value.url;
      }
      saveSession(next, issued, nextArchives);
      location.assign(`/s/${data.id}#${data.accessToken}`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function renew(role) {
    setBusy(true); setMessage('');
    try {
      const data = await request(`/api/sessions/${session.id}/access`, { method: 'POST', body: JSON.stringify({ role }) });
      const nextLinks = { ...links, [role]: data.url };
      saveSession(session, nextLinks);
      setMessage(`Link de ${role === 'viewer' ? 'visualização' : 'operação'} renovado.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function revoke(role) {
    setBusy(true); setMessage('');
    try {
      await request(`/api/sessions/${session.id}/access`, { method: 'DELETE', body: JSON.stringify({ role }) });
      const nextLinks = { ...links }; delete nextLinks[role]; saveSession(session, nextLinks);
      setMessage(`Acesso de ${role === 'viewer' ? 'visualizador' : 'operador'} revogado.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function copy(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setMessage('Link copiado.');
        return;
      }
    } catch {}
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    field.remove();
    setMessage(copied ? 'Link copiado.' : 'Não foi possível copiar automaticamente; selecione e copie o link.');
  }

  function openOrganizer(url) {
    if (url) window.location.assign(url);
  }

  function archivedLinks() {
    if (!archives.length) return null;
    return <div className="sync-archives"><strong>Salas encerradas</strong>{archives.map(room => <div className="sync-archive" key={room.id}>
      <small>ID: {room.id}</small>
      {room.links?.viewer && <div className="sync-link-row"><strong>Visualizador</strong><input readOnly value={room.links.viewer} onFocus={event => event.target.select()} /><button type="button" onClick={() => copy(room.links.viewer)}>Copiar</button></div>}
      {room.organizerUrl && <div className="sync-link-row"><strong>Organizador</strong><input readOnly value={room.organizerUrl} onFocus={event => event.target.select()} /><button type="button" onClick={() => copy(room.organizerUrl)}>Copiar</button><button type="button" onClick={() => openOrganizer(room.organizerUrl)}>Abrir</button></div>}
    </div>)}</div>;
  }

  function clearFinishedRooms() {
    const hasFinishedCurrent = session?.status === 'finished';
    if (!archives.length && !hasFinishedCurrent) {
      setMessage('Não há salas encerradas para limpar.');
      return;
    }
    if (!confirm('Limpar as salas encerradas salvas neste navegador? Isso não apaga as salas nem os links do banco de dados.')) return;

    setArchives([]);
    if (hasFinishedCurrent) {
      setSession(null);
      setLinks({});
      localStorage.removeItem(STORAGE_KEY);
    } else if (session) {
      saveSession(session, links, []);
    } else {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      const matchesRoom = !roomId || saved?.id === roomId;
        if (saved) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, archives: [] }));
      } catch {}
    }
    setMessage('Salas encerradas removidas deste navegador. Os registros no banco continuam disponíveis pelos links.');
  }

  return <>
    {(!roomId || session?.id === roomId) && <button className={['sync-launch', triggerClassName].filter(Boolean).join(' ')} type="button" onClick={() => setOpen(true)}>{roomId ? 'Links da sala' : 'Ativar sincronização'}</button>}
    {open && typeof document !== 'undefined' && createPortal(<div className="sync-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-title">
        <button className="sync-close" onClick={() => setOpen(false)} aria-label="Fechar" type="button">×</button>
        <h2 id="sync-title">Sincronização da sala</h2>
        {!session ? <>
          <p>A sala será criada com uma cópia do sorteio e do placar deste aparelho.</p>
          {!hasDraw && <p className="sync-note">Não há um sorteio em andamento neste aparelho.</p>}
          <button className="sync-primary" type="button" disabled={busy || !hasDraw} onClick={activate}>{busy ? 'Ativando…' : 'Ativar sincronização'}</button>
        </> : session.status === 'finished' ? <>
          <p>Competição encerrada. Esta sala permanece disponível somente para visualização.</p>
          {session.links?.viewer && <div className="sync-link-row"><strong>Visualizador</strong><input readOnly value={session.links.viewer} onFocus={event => event.target.select()} /><button type="button" onClick={() => copy(session.links.viewer)}>Copiar</button></div>}
          {session.organizerUrl && <div className="sync-link-row"><strong>Organizador</strong><input readOnly value={session.organizerUrl} onFocus={event => event.target.select()} /><button type="button" onClick={() => copy(session.organizerUrl)}>Copiar</button><button type="button" onClick={() => openOrganizer(session.organizerUrl)}>Abrir</button></div>}
          <small>ID da sala: {session.id}</small>
          <button className="sync-primary" type="button" disabled={busy || !hasDraw} onClick={activate}>{busy ? 'Criando…' : 'Ativar nova sala'}</button>
          {!hasDraw && <p className="sync-note">Abra um sorteio com andamento neste aparelho para criar outra sala.</p>}
          {archivedLinks()}
        </> : <>
          <p>Sala ativa. Compartilhe os links abaixo; renovar um link invalida o anterior.</p>
          <div className="sync-link-row"><strong>Organizador</strong><input readOnly value={session.organizerUrl} onFocus={event => event.target.select()} /><button type="button" onClick={() => copy(session.organizerUrl)}>Copiar</button><button type="button" onClick={() => openOrganizer(session.organizerUrl)}>Abrir</button></div>
          {ROLES.map(([role, label]) => <div className="sync-access" key={role}>
            <strong>{label}</strong>
            {links[role] ? <><input readOnly value={links[role]} onFocus={event => event.target.select()} /><button type="button" disabled={busy} onClick={() => copy(links[role])}>Copiar</button><button type="button" disabled={busy} onClick={() => revoke(role)}>Revogar</button></> : <span>Acesso revogado ou ainda não emitido.</span>}
            <button type="button" disabled={busy} onClick={() => renew(role)}>{links[role] ? 'Renovar' : 'Emitir link'}</button>
          </div>)}
          <small>ID da sala: {session.id}</small>
          {archivedLinks()}
        </>}
        {message && <p className="sync-message" role="status">{message}</p>}
        <div className="sync-dialog-footer">
          <button className="sync-clear" type="button" disabled={busy || (!archives.length && session?.status !== 'finished')} onClick={clearFinishedRooms}>Limpar salas</button>
        </div>
      </section>
    </div>, document.body)}
  </>;
}
